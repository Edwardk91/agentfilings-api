import { Hono } from "hono";
import { TTL, type TtlCache } from "../lib/cache";
import { fail, ok, statusForCode } from "../lib/response";
import type { CorpusRepo } from "../repo/corpus-repo";
import { queryLatestFilings } from "../services/queries";

// PAID endpoint ($0.01, handoff §4). The x402 v2 gate is added in the payment-wiring
// step; until then this serves openly in dev and MUST NOT be deployed.
export function filingsLatest(repo: CorpusRepo, cache: TtlCache) {
  const router = new Hono();

  router.get("/", async (c) => {
    const ticker = c.req.query("ticker")?.trim().toUpperCase();
    // Form types are upper-case in EDGAR (10-K, S-1); normalize for match + cache key.
    const form = c.req.query("form")?.trim().toUpperCase() || undefined;
    const limitRaw = c.req.query("limit");

    // Presence-encoded so a literal value can never alias the no-filter case.
    const cacheKey = `filings:${ticker ?? "-"}:${form ? `f:${form}` : "-"}:${limitRaw ?? "20"}`;
    const cached = cache.get<object>(cacheKey);
    if (cached) {
      return c.json(ok(cached, { source_api: "sec-edgar-submissions", cache: "hit" }));
    }

    const result = await queryLatestFilings(repo, { ticker, form, limit: limitRaw });
    if (!result.ok) {
      return c.json(fail(result.code, result.message), statusForCode(result.code));
    }

    cache.set(cacheKey, result.data, TTL.latestFilings);
    return c.json(ok(result.data, { source_api: result.sourceApi, cache: "miss" }));
  });

  return router;
}
