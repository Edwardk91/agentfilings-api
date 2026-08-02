import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../index";
import { LocalJsonCorpusRepo } from "../repo/corpus-repo";
import { createSubscriptionGate } from "./gate";
import {
  InMemoryApiKeyStore,
  extractApiKey,
  generateApiKey,
  hashKey,
  hashesEqual,
  looksLikeApiKey,
} from "./keys";

const corpusDir = fileURLToPath(new URL("../../test/fixtures/corpus", import.meta.url));

describe("api key primitives", () => {
  it("generates distinct keys with a stable, non-secret prefix", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.raw).not.toBe(b.raw);
    expect(a.raw.startsWith("af_live_")).toBe(true);
    expect(a.keyPrefix.startsWith("af_live_")).toBe(true);
    // The stored prefix must be a strict, shorter prefix of the raw key — enough to
    // identify it in support, never enough to use it.
    expect(a.raw.startsWith(a.keyPrefix)).toBe(true);
    expect(a.keyPrefix.length).toBeLessThan(a.raw.length);
  });

  it("hashes deterministically and never stores the raw key", () => {
    const key = generateApiKey();
    expect(hashKey(key.raw)).toBe(key.keyHash);
    expect(key.keyHash).not.toContain(key.raw);
    expect(key.keyHash).toHaveLength(64); // sha256 hex
  });

  it("compares hashes in constant time without throwing on bad input", () => {
    const a = hashKey("one");
    expect(hashesEqual(a, a)).toBe(true);
    expect(hashesEqual(a, hashKey("two"))).toBe(false);
    expect(hashesEqual(a, "")).toBe(false);
    expect(hashesEqual("", "")).toBe(false);
  });

  it("reads a key from either header convention", () => {
    const k = "af_live_abc";
    expect(extractApiKey({ authorization: `Bearer ${k}` })).toBe(k);
    expect(extractApiKey({ authorization: `bearer ${k}` })).toBe(k);
    expect(extractApiKey({ apiKey: k })).toBe(k);
    // x-api-key wins when both are present; it is the more explicit signal.
    expect(extractApiKey({ authorization: "Bearer other", apiKey: k })).toBe(k);
    expect(extractApiKey({})).toBeNull();
    expect(extractApiKey({ authorization: "Basic zzz" })).toBeNull();
  });

  it("recognises only plausibly-shaped keys", () => {
    expect(looksLikeApiKey(generateApiKey().raw)).toBe(true);
    expect(looksLikeApiKey("af_live_short")).toBe(false);
    expect(looksLikeApiKey("sk_test_1234567890123456789012345")).toBe(false);
  });
});

/** A stand-in for the x402 middleware that records whether it was reached. */
function spyX402(): { middleware: MiddlewareHandler; called: () => boolean } {
  let hit = false;
  return {
    middleware: async (c) => {
      hit = true;
      return c.json({ x402: "payment required" }, 402);
    },
    called: () => hit,
  };
}

async function gatedApp(store: InMemoryApiKeyStore, x402?: MiddlewareHandler) {
  const app = new Hono();
  app.use(createSubscriptionGate({ store, x402 }));
  app.get("/paid", (c) => c.json({ ok: true, subscriber: c.get("subscriber")?.keyPrefix ?? null }));
  return app;
}

describe("subscription gate", () => {
  it("falls through to x402 when no key is supplied", async () => {
    const spy = spyX402();
    const app = await gatedApp(new InMemoryApiKeyStore(), spy.middleware);
    const res = await app.request("/paid");
    expect(res.status).toBe(402);
    expect(spy.called()).toBe(true);
  });

  it("serves a valid key without invoking x402", async () => {
    const store = new InMemoryApiKeyStore();
    const key = generateApiKey();
    await store.insert({ keyHash: key.keyHash, keyPrefix: key.keyPrefix });

    const spy = spyX402();
    const app = await gatedApp(store, spy.middleware);
    const res = await app.request("/paid", { headers: { "x-api-key": key.raw } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; subscriber: string | null };
    expect(body.ok).toBe(true);
    expect(body.subscriber).toBe(key.keyPrefix);
    // The whole point of the subscription: no per-call charge.
    expect(spy.called()).toBe(false);
  });

  it("401s a bad key instead of falling through to a payment challenge", async () => {
    // This is the security-relevant case. A 402 here would tell a lapsed subscriber
    // (or their agent, holding a funded wallet) to pay again for something they
    // believe they already pay for monthly.
    const store = new InMemoryApiKeyStore();
    const unknown = generateApiKey();

    for (const header of [unknown.raw, "af_live_malformed", "garbage"]) {
      const spy = spyX402();
      const app = await gatedApp(store, spy.middleware);
      const res = await app.request("/paid", { headers: { "x-api-key": header } });

      expect(res.status).toBe(401);
      expect(spy.called()).toBe(false);
      const body = (await res.json()) as { error: { code: string; hint: string } };
      expect(body.error.code).toBe("unauthorized");
      expect(body.error.hint).toContain("/billing/subscribe");
    }
  });

  it("stops honouring a key once its subscription is cancelled", async () => {
    const store = new InMemoryApiKeyStore();
    const key = generateApiKey();
    await store.insert({
      keyHash: key.keyHash,
      keyPrefix: key.keyPrefix,
      stripeSubscriptionId: "sub_123",
    });

    const app = await gatedApp(store, spyX402().middleware);
    expect((await app.request("/paid", { headers: { "x-api-key": key.raw } })).status).toBe(200);

    const changed = await store.setStatusBySubscription("sub_123", "canceled");
    expect(changed).toBe(1);

    const after = await app.request("/paid", { headers: { "x-api-key": key.raw } });
    expect(after.status).toBe(401);
  });

  it("treats past_due as no longer active", async () => {
    const store = new InMemoryApiKeyStore();
    const key = generateApiKey();
    await store.insert({
      keyHash: key.keyHash,
      keyPrefix: key.keyPrefix,
      stripeSubscriptionId: "sub_pd",
    });
    await store.setStatusBySubscription("sub_pd", "past_due");
    const app = await gatedApp(store, spyX402().middleware);
    expect((await app.request("/paid", { headers: { "x-api-key": key.raw } })).status).toBe(401);
  });
});

describe("the gate inside the real app", () => {
  it("rejects a bad key on a paid route and leaves free routes alone", async () => {
    const store = new InMemoryApiKeyStore();
    const app = createApp({ repo: new LocalJsonCorpusRepo(corpusDir), keys: store });

    const bad = await app.request("/earnings/summary?ticker=AAPL", {
      headers: { "x-api-key": "af_live_not_a_real_key_at_all_xxxx" },
    });
    expect(bad.status).toBe(401);

    // /probe is the free trust anchor and must never require a key.
    const probe = await app.request("/probe?ticker=AAPL", {
      headers: { "x-api-key": "af_live_not_a_real_key_at_all_xxxx" },
    });
    expect(probe.status).toBe(200);
  });

  it("serves a paid route to a valid subscriber", async () => {
    const store = new InMemoryApiKeyStore();
    const key = generateApiKey();
    await store.insert({ keyHash: key.keyHash, keyPrefix: key.keyPrefix });
    const app = createApp({ repo: new LocalJsonCorpusRepo(corpusDir), keys: store });

    const res = await app.request("/earnings/summary?ticker=AAPL", {
      headers: { authorization: `Bearer ${key.raw}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBeGreaterThan(0);
  });
});
