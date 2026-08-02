import { describe, expect, it } from "vitest";
import {
  InMemoryIdempotencyStore,
  PaymentGuard,
  type PaymentProof,
  RateLimiter,
  type RequestContext,
  resourceId,
} from "../../apps/api/src/payments/index";

// Real tests for the x402 payment-security guarantees (handoff §5.2). These exercise
// the seller-side controls the protocol/facilitator does not provide.

const NOW = 1_800_000_000; // fixed unix seconds

function proof(overrides: Partial<PaymentProof> = {}): PaymentProof {
  return { payId: "nonce-1", validAfter: NOW - 30, validBefore: NOW + 30, ...overrides };
}
function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return { method: "GET", path: "/earnings/summary", query: { ticker: "AAPL" }, ...overrides };
}
const alwaysVerified = async () => true;

describe("x402 payment security (handoff §5.2)", () => {
  it("verifies settlement server-side before serving (never trusts client proof alone)", async () => {
    let called = false;
    const guard = new PaymentGuard(new InMemoryIdempotencyStore(), async () => {
      called = true;
      return true;
    });
    const decision = await guard.authorize(proof(), ctx(), NOW);
    expect(called).toBe(true);
    expect(decision.ok).toBe(true);
  });

  it("does not serve when settlement verification fails", async () => {
    const guard = new PaymentGuard(new InMemoryIdempotencyStore(), async () => false);
    const decision = await guard.authorize(proof(), ctx(), NOW);
    expect(decision).toMatchObject({ ok: false, code: "payment_invalid" });
  });

  it("binds each proof to the resource and rejects cross-resource substitution", async () => {
    const guard = new PaymentGuard(new InMemoryIdempotencyStore(), alwaysVerified);
    const first = await guard.authorize(proof(), ctx({ path: "/filings/latest" }), NOW);
    expect(first.ok).toBe(true);
    const substituted = await guard.authorize(proof(), ctx({ path: "/earnings/summary" }), NOW);
    expect(substituted).toMatchObject({ ok: false, code: "payment_replayed" });
  });

  it("claims the payment id atomically, then serves the cached response on identical replay", async () => {
    const guard = new PaymentGuard(new InMemoryIdempotencyStore(), alwaysVerified);
    const request = ctx();
    expect(await guard.authorize(proof(), request, NOW)).toEqual({ ok: true, replay: false });
    expect(await guard.authorize(proof(), request, NOW)).toEqual({ ok: true, replay: true });
  });

  it("rejects a duplicate payment id presented against a different request hash", async () => {
    const guard = new PaymentGuard(new InMemoryIdempotencyStore(), alwaysVerified);
    await guard.authorize(proof(), ctx({ query: { ticker: "AAPL" } }), NOW);
    const other = await guard.authorize(proof(), ctx({ query: { ticker: "MSFT" } }), NOW);
    expect(other).toMatchObject({ ok: false, code: "payment_replayed" });
  });

  it("rejects a proof outside the expiry window but tolerates ±60s clock skew", async () => {
    const guard = new PaymentGuard(new InMemoryIdempotencyStore(), alwaysVerified);
    expect(await guard.authorize(proof({ validBefore: NOW - 120 }), ctx(), NOW)).toMatchObject({
      ok: false,
      code: "payment_invalid",
    });
    expect(await guard.authorize(proof({ validAfter: NOW + 120 }), ctx(), NOW)).toMatchObject({
      ok: false,
      code: "payment_invalid",
    });
    // Just-expired within the skew window is still accepted.
    expect((await guard.authorize(proof({ validBefore: NOW - 30 }), ctx(), NOW)).ok).toBe(true);
  });

  it("enforces per-key (per-IP / per-wallet) rate limits independently", () => {
    const rl = new RateLimiter();
    expect(rl.check("ip:1.2.3.4", 2, 1000)).toBe(true);
    expect(rl.check("ip:1.2.3.4", 2, 1000)).toBe(true);
    expect(rl.check("ip:1.2.3.4", 2, 1000)).toBe(false); // 3rd call exceeds limit 2
    expect(rl.check("wallet:0xabc", 2, 1000)).toBe(true); // different key, own budget
  });

  it("resourceId is stable regardless of query ordering", () => {
    const a = resourceId({ method: "GET", path: "/x", query: { b: "2", a: "1" } });
    const b = resourceId({ method: "GET", path: "/x", query: { a: "1", b: "2" } });
    expect(a).toBe(b);
  });
});
