import { Hono } from "hono";
import { ENDPOINTS, PRICE_BAND_USD } from "@agentfilings/shared";

// llms.txt — a plain-text service description for LLM consumers (handoff §8 GTM).
// Generated from the pricing table rather than served from a static file so it can
// never contradict what the service actually sells.

export function llmsTxt(baseUrl: string) {
  const router = new Hono();
  const base = baseUrl.replace(/\/$/, "");

  router.get("/", (c) => {
    const line = (e: (typeof ENDPOINTS)[number]) =>
      `- ${e.method} ${e.path} — ${e.priceUsd > 0 ? "$" + e.priceUsd.toFixed(2) : "free"}. ${e.summary}`;

    const body = `# AgentFilings

> Structured US SEC/EDGAR filing data for autonomous agents: filings index,
> XBRL-derived earnings summaries, and Form 4 insider transactions as clean JSON.
> Public-domain SEC data, pre-parsed and normalized. Pay per call with x402
> (USDC on Base). No account, no API key.

Base URL: ${base}
OpenAPI: ${base}/openapi.json
MCP (streamable HTTP): ${base}/mcp

## Start here (free)

${base}/probe?ticker=AAPL

/probe tells you, before you spend anything: whether a ticker is covered, how much
data exists, how fresh it is, which endpoints will return something, and the exact
price of every endpoint. If a ticker is not covered, paid endpoints return 404 — so
check /probe rather than paying to find out.

## Endpoints

${ENDPOINTS.filter((e) => e.available).map(line).join("\n")}

Prices are per call, ${"$"}${PRICE_BAND_USD.min.toFixed(2)}–${"$"}${PRICE_BAND_USD.max.toFixed(2)}.

## Responses

Every response is { data, meta }. meta carries the SEC source (accession number or
API), when the underlying filing was filed, when this service assembled the
response, and whether it was a cache hit. Errors carry a machine-readable code, a
message, and a hint.

## Payment

Paid endpoints answer HTTP 402 with payment requirements in the base64
PAYMENT-REQUIRED header (x402 v2 — not the body). Pay in USDC on Base mainnet, then
retry. Standard x402 clients handle this automatically.

## Data notes

- Source: SEC EDGAR, public domain. Refreshed on a daily rotation: a given company's
  metadata every ~3 days, its Form 4 data every ~19 days.
- Earnings are derived from XBRL company facts, not from parsing documents.
  Restated figures resolve to the latest value, while each period keeps the fiscal
  year and quarter from its ORIGINAL filing, so prior-year comparatives embedded in
  later filings do not corrupt the labels.
- Every earnings period and insider transaction carries its source accession number.
- Coverage is US public companies filing with SEC EDGAR, and is still expanding.
  Do not assume a fixed index — call /probe?ticker= for the authoritative answer on
  any specific company. Tickers resolving to a post-reorganization shell with no XBRL
  history are deliberately excluded rather than reported as empty.
`;
    // Pass a status explicitly. Under @hono/node-server 1.19.14 a bare c.text(body)
    // answers HEAD with a 500 — reproduced in isolation, and seen in production from a
    // crawler checking this file. Any form carrying a status is unaffected, which is why
    // robots.txt never showed it. Hono's own test harness bypasses the Node adapter, so
    // only the regression test that serves over a real socket catches this.
    return c.text(body, 200, { "cache-control": "public, max-age=3600" });
  });

  return router;
}
