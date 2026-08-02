import { Hono } from "hono";
import { TTL, type TtlCache } from "../lib/cache";
import { fail, ok, statusForCode } from "../lib/response";
import type { CorpusRepo } from "../repo/corpus-repo";
import { queryEarningsSummary } from "../services/queries";

// PAID endpoint ($0.02, handoff §4). XBRL-derived — no PDF/HTML parsing. The x402 v2
// gate is added in the payment-wiring step; until then serves openly in dev only.
//
// `period` filter accepts: "annual" | "quarterly" | "interim", a fiscal year
// ("2025" or "FY2025"), or an SEC frame ("CY2026Q1"). Omitted = all periods.
export function earningsSummary(repo: CorpusRepo, cache: TtlCache) {
  const router = new Hono();

  router.get("/", async (c) => {
    const ticker = c.req.query("ticker")?.trim().toUpperCase();
    const period = c.req.query("period")?.trim() || undefined;

    // Lower-cased (repo matches case-insensitively) and presence-encoded.
    const cacheKey = `earnings:${ticker ?? "-"}:${period ? `p:${period.toLowerCase()}` : "-"}`;
    const cached = cache.get<object>(cacheKey);
    if (cached) {
      return c.json(ok(cached, { source_api: "sec-edgar-companyfacts", cache: "hit" }));
    }

    const result = await queryEarningsSummary(repo, { ticker, period });
    if (!result.ok) {
      return c.json(fail(result.code, result.message), statusForCode(result.code));
    }

    cache.set(cacheKey, result.data, TTL.earnings);
    return c.json(ok(result.data, { source_api: result.sourceApi, cache: "miss" }));
  });

  return router;
}
