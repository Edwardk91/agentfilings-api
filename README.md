# AgentFilings

Structured US SEC/EDGAR filing data for AI agents — filings index, XBRL-derived
earnings, and Form 4 insider transactions as clean JSON, over both HTTP and MCP.

Two payment rails: **x402** (USDC on Base mainnet, no account required) for
autonomous agents, and a **flat Stripe subscription** for anyone who'd rather use a
card and an API key.

Live at [api.agentfilings.com](https://api.agentfilings.com) ·
[OpenAPI](https://api.agentfilings.com/openapi.json) ·
[llms.txt](https://api.agentfilings.com/llms.txt) ·
MCP at `https://api.agentfilings.com/mcp`

```bash
# Free. Tells you what data exists before you spend anything.
curl "https://api.agentfilings.com/probe?ticker=AAPL"
```

## What's actually interesting in here

Most of the work went into three things that are easy to get wrong with SEC data,
and one that's easy to get wrong with agent payments.

**Restatements.** `companyfacts` returns the same period once per filing that
reported it. When a company restates a figure, the superseded value is still in the
API. Each period here reconciles to its most recently filed value rather than the
first one encountered.

**Fiscal period provenance.** The `fy`/`fp` fields on a fact describe the *filing*,
not the period. A 10-Q showing last year's quarter as a comparative stamps that
older period with the newer filing's fiscal year. Each period here keeps the labels
from the filing that *originally* reported it. [`benchmark/`](./benchmark) is a
runnable measurement of how often those disagree.

**Entity identity.** SEC's ticker map can point at a post-reorganization shell that
holds the ticker and files no financial data. Resolution is CIK-authoritative, with
a guard that refuses to record coverage for an entity reporting no `us-gaap` facts.

**Payment replay.** Every x402 payment proof is bound to the specific resource it
paid for, so a proof issued for one endpoint or MCP tool cannot be replayed against
another. Settlement is idempotent, and EIP-712 domains are read per-network from the
USDC contracts rather than hardcoded.

## Honest coverage

`/probe` is free, and it will tell you **not** to pay:

```json
{
  "ticker_coverage": {
    "covered": true,
    "endpoints_with_data": ["/filings/latest", "/earnings/summary"],
    "empty_endpoints": ["/insiders"],
    "hint": "Partial coverage. /filings/latest and /earnings/summary will return data. /insiders would return an empty result, so do not pay for those."
  }
}
```

A company can be covered for filings and empty for earnings — foreign issuers
filing under IFRS, pre-revenue companies. Charging for a call that returns nothing
is the fastest way to lose an automated buyer permanently, so the service says so
before taking money.

## Layout

```
apps/api/          TypeScript / Hono — HTTP API + MCP server
  src/payments/    x402 v2: routes config, replay guard, idempotency, discovery
  src/billing/     Stripe rail: key issuance, subscription gate, checkout, webhook
  src/mcp/         MCP over streamable HTTP, paid tools
  src/repo/        Corpus access (Postgres in prod, local JSON in tests)
apps/ingest/       Python 3.12 — SEC ingestion, XBRL + Form 4 parsers
packages/shared/   Pricing table, x402 constants, response types
infra/migrations/  SQL schema
benchmark/         Standalone, runnable SEC XBRL correctness measurement
tests/             Cross-cutting, including the payment-security spec
```

`packages/shared/src/pricing.ts` is the single source of truth for the API surface.
The payment middleware, `/probe`, the MCP tool list and the OpenAPI document all
derive from it.

## Development

```bash
pnpm install
pnpm test        # vitest — api + shared
pnpm typecheck
pnpm lint
pnpm dev         # http://localhost:8080

curl localhost:8080/health
curl "localhost:8080/probe?ticker=AAPL"
```

Payments are gated off by default, so paid routes serve openly in development.
Ingestion requires `SEC_CONTACT_EMAIL` — the SEC requires a contact in the
User-Agent and blocks requests without one. See [`.env.example`](./.env.example)
and [`infra/DEPLOY.md`](./infra/DEPLOY.md).

## Principles

- **The free surface is honest.** `/health` and `/probe` are always free, and
  `/probe` never overstates coverage.
- **Never charge for what cannot be served.** An unimplemented endpoint is never
  payment-gated — the middleware would otherwise take payment and then 404.
- **Public domain only.** SEC EDGAR. No licensed datasets, no scraped transcripts.
- **Merchant only.** The service never holds, routes, or forwards third-party funds.

## Licence

MIT. Data is SEC EDGAR, public domain.
