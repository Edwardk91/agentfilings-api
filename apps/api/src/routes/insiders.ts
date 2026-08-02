import { Hono } from "hono";
import { TTL, type TtlCache } from "../lib/cache";
import { fail, ok, statusForCode } from "../lib/response";
import type { CorpusRepo } from "../repo/corpus-repo";
import { queryInsiders } from "../services/queries";

// PAID endpoint ($0.01, handoff §4). Form 4 insider transactions for a ticker,
// optionally since a date. Served openly until the x402 gate is enabled.
export function insiders(repo: CorpusRepo, cache: TtlCache) {
  const router = new Hono();

  router.get("/", async (c) => {
    const ticker = c.req.query("ticker")?.trim().toUpperCase();
    const since = c.req.query("since")?.trim() || undefined;

    const cacheKey = `insiders:${ticker ?? "-"}:${since ? `s:${since}` : "-"}`;
    const cached = cache.get<object>(cacheKey);
    if (cached) {
      return c.json(ok(cached, { source_api: "sec-edgar-form4", cache: "hit" }));
    }

    const result = await queryInsiders(repo, { ticker, since });
    if (!result.ok) {
      return c.json(fail(result.code, result.message), statusForCode(result.code));
    }

    cache.set(cacheKey, result.data, TTL.insiders);
    return c.json(ok(result.data, { source_api: result.sourceApi, cache: "miss" }));
  });

  return router;
}
