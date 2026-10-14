import { Hono } from "hono";
import { ENDPOINTS, PRICE_BAND_USD, SUBSCRIPTION } from "@agentfilings/shared";
import { ok } from "../lib/response";
import type { CorpusRepo, TickerCoverage } from "../repo/corpus-repo";

// A company can be covered for one dataset and empty for another. Foreign issuers
// file under IFRS and pre-revenue companies omit the standard revenue/EPS concepts,
// so they have filings but no earnings periods. Saying "covered" without qualifying
// which endpoints have data invites an agent to pay for an empty result, which is
// exactly what /probe exists to prevent.
const DATASETS: { path: string; count: (c: TickerCoverage) => number }[] = [
  { path: "/filings/latest", count: (c) => c.filings },
  { path: "/earnings/summary", count: (c) => c.earningsPeriods },
  { path: "/insiders", count: (c) => c.insiderTransactions },
];

function withData(c: TickerCoverage): string[] {
  return c.covered ? DATASETS.filter((d) => d.count(c) > 0).map((d) => d.path) : [];
}

function emptyEndpoints(c: TickerCoverage): string[] {
  return c.covered ? DATASETS.filter((d) => d.count(c) === 0).map((d) => d.path) : [];
}

function coverageHint(c: TickerCoverage): string {
  if (!c.covered) {
    return "Not covered. Paid endpoints return 404 for this ticker; do not pay.";
  }
  const empty = emptyEndpoints(c);
  const has = withData(c);
  if (empty.length === 0) return "Covered. All paid endpoints will return data.";
  if (has.length === 0) {
    return "Known company, but no data is loaded for any paid endpoint yet; do not pay.";
  }
  return (
    `Partial coverage. ${has.join(" and ")} will return data. ` +
    `${empty.join(" and ")} would return an empty result, so do not pay for those.`
  );
}

// Free, deterministic pre-payment surface (handoff §4).
//
// This is the trust anchor of the whole service: an agent can ask "do you have this
// ticker, how much data, how fresh, and what will it cost?" and get an honest answer
// for free. Never charge for it, and never overstate coverage — a paid call that
// returns nothing is the fastest way to lose a buyer permanently.
export function probe(repo: CorpusRepo) {
  const router = new Hono();

  router.get("/", async (c) => {
    const ticker = c.req.query("ticker")?.trim().toUpperCase() || null;
    const [coverage, tickerCoverage] = await Promise.all([
      repo.getCoverage(),
      ticker ? repo.getTickerCoverage(ticker) : Promise.resolve(null),
    ]);

    return c.json(
      ok(
        {
          service: "agentfilings",
          description:
            "Structured US SEC filing data for autonomous agents: filings index, " +
            "XBRL-derived earnings, and Form 4 insider transactions as clean JSON.",
          ticker,
          // Present only when a ticker was supplied — the answer to "should I pay?".
          ticker_coverage: tickerCoverage
            ? {
                covered: tickerCoverage.covered,
                company: tickerCoverage.company ?? null,
                available: {
                  filings: tickerCoverage.filings,
                  earnings_periods: tickerCoverage.earningsPeriods,
                  insider_transactions: tickerCoverage.insiderTransactions,
                },
                last_updated: tickerCoverage.lastUpdated,
                // Which paid endpoints will actually return data for this ticker.
                endpoints_with_data: withData(tickerCoverage),
                empty_endpoints: emptyEndpoints(tickerCoverage),
                hint: coverageHint(tickerCoverage),
              }
            : null,
          coverage: {
            // Never name a fixed index here. The corpus grew past the S&P 500 during
            // backfill, and an agent told "S&P 500" would skip thousands of tickers
            // that are in fact covered. companies_covered is the live count; the
            // per-ticker answer above is the authoritative one for any decision.
            universe: "US public companies filing with SEC EDGAR",
            companies_covered: coverage.covered,
            source: "SEC EDGAR (public domain)",
          },
          freshness: {
            last_ingest_at: coverage.lastIngestAt,
            cadence: "daily rotation: metadata ~3 days, Form 4 ~19 days per company",
          },
          // Only what can actually be bought today. Advertising a price for an
          // unimplemented route invites an agent to pay for nothing.
          pricing: ENDPOINTS.filter((e) => e.available).map((e) => ({
            id: e.id,
            method: e.method,
            path: e.path,
            price_usd: e.priceUsd,
            stage: e.stage,
            mcp_tool: e.mcpTool ?? null,
            summary: e.summary,
          })),
          planned: ENDPOINTS.filter((e) => !e.available).map((e) => ({
            path: e.path,
            summary: e.summary,
            status: "not yet available — not payable",
          })),
          price_band_usd: PRICE_BAND_USD,
          payment: {
            per_call: {
              protocol: "x402",
              asset: "USDC",
              note: "Paid routes answer 402 with payment requirements in the PAYMENT-REQUIRED header.",
            },
            subscription: {
              price_usd_per_month: SUBSCRIPTION.priceUsdPerMonth,
              note:
                "Flat monthly alternative: unlimited calls to every paid endpoint with an API key, " +
                "no per-call charge. Cheaper than per-call above ~1,000 calls/month.",
              subscribe: "/billing/subscribe",
              auth: "Send the key as `x-api-key` or `Authorization: Bearer …`.",
            },
          },
        },
        { source_api: "internal" },
      ),
    );
  });

  return router;
}
