import type { SettleContext, SettleResultContext } from "@x402/core/server";
import { describe, expect, it } from "vitest";
import { InMemoryIdempotencyStore } from "./idempotency";
import { createPaymentGuardExtension, extractProofFromPayload, GUARD_EXTENSION_KEY } from "./x402-guard";

const NOW = 1_800_000_000;
const clock = () => NOW;

function payload(nonce: string, validAfter = NOW - 30, validBefore = NOW + 30) {
  return {
    payload: {
      authorization: { nonce, validAfter: String(validAfter), validBefore: String(validBefore) },
    },
  };
}

function settleCtx(nonce: string, resource: string, validAfter?: number, validBefore?: number) {
  return {
    paymentPayload: payload(nonce, validAfter, validBefore),
    requirements: { resource },
  } as unknown as SettleContext;
}

describe("extractProofFromPayload", () => {
  it("pulls nonce + validity window from the EIP-3009 authorization", () => {
    const proof = extractProofFromPayload(payload("0xnonce", NOW - 10, NOW + 50));
    expect(proof).toEqual({ payId: "0xnonce", validAfter: NOW - 10, validBefore: NOW + 50 });
  });

  it("returns null for a malformed payload", () => {
    expect(extractProofFromPayload({})).toBeNull();
    expect(extractProofFromPayload({ payload: {} })).toBeNull();
    expect(extractProofFromPayload(null)).toBeNull();
  });
});

describe("payment guard extension", () => {
  function make(store = new InMemoryIdempotencyStore()) {
    const ext = createPaymentGuardExtension(store, clock);
    return { store, hooks: ext.hooks!, key: ext.key };
  }

  it("declares the guard key", () => {
    expect(make().key).toBe(GUARD_EXTENSION_KEY);
  });

  it("lets a fresh payment settle, then records the binding afterward", async () => {
    const { store, hooks } = make();
    const before = await hooks.onBeforeSettle!({}, settleCtx("n1", "res-A"));
    expect(before).toBeUndefined(); // proceed to settle

    const settled = { ...settleCtx("n1", "res-A"), result: {} } as unknown as SettleResultContext;
    await hooks.onAfterSettle!({}, settled);
    expect(await store.check("n1", "res-A")).toBe("replay_same_resource");
  });

  it("aborts a payment reused against a different resource (cross-resource replay)", async () => {
    const { store, hooks } = make();
    await store.record("n1", "res-A", 60_000);
    const decision = await hooks.onBeforeSettle!({}, settleCtx("n1", "res-B"));
    expect(decision).toMatchObject({ abort: true });
  });

  it("does not record a claim before settlement (failed settle leaves nothing)", async () => {
    const { store, hooks } = make();
    await hooks.onBeforeSettle!({}, settleCtx("n1", "res-A")); // proceed, but no onAfterSettle
    expect(await store.check("n1", "res-A")).toBe("fresh");
  });

  it("aborts a proof outside its validity window", async () => {
    const { hooks } = make();
    const decision = await hooks.onBeforeSettle!({}, settleCtx("n1", "res-A", NOW - 500, NOW - 200));
    expect(decision).toMatchObject({ abort: true });
  });
});
