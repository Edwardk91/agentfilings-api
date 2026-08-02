// Single source of truth for the API surface and per-route pricing (handoff §4).
// The x402 middleware, the /probe response, the MCP tool list, and the OpenAPI
// spec all derive from this array. Prices are USD; x402 charges the USDC equivalent.

export type HttpMethod = "GET" | "POST";

export interface EndpointSpec {
  /** Stable id: pricing key, MCP tool base, OpenAPI operationId. */
  id: string;
  method: HttpMethod;
  /** Route path template. */
  path: string;
  /** USD price per call. 0 means free — must never require payment. */
  priceUsd: number;
  stage: 0 | 1 | 2;
  /** MCP tool name mirroring this endpoint 1:1, if exposed. */
  mcpTool?: string;
  summary: string;
  /**
   * Whether the endpoint is actually implemented and servable RIGHT NOW.
   *
   * Planned-but-unbuilt routes must never be payment-gated: the middleware would
   * issue a valid 402, take the agent's money, and then 404 because no handler is
   * mounted. Never charge for something that cannot be served.
   */
  available: boolean;
}

export const ENDPOINTS: readonly EndpointSpec[] = [
  {
    id: "health",
    method: "GET",
    path: "/health",
    priceUsd: 0,
    stage: 0,
    summary: "Liveness probe.",
    available: true,
  },
  {
    id: "probe",
    method: "GET",
    path: "/probe",
    priceUsd: 0,
    stage: 0,
    mcpTool: "probe_coverage",
    summary:
      "Coverage, freshness timestamps, and per-endpoint pricing so agents can decide before paying.",
    available: true,
  },
  {
    id: "filings_latest",
    method: "GET",
    path: "/filings/latest",
    priceUsd: 0.01,
    stage: 0,
    mcpTool: "get_latest_filings",
    summary: "Latest filings for a ticker, optionally filtered by form type.",
    available: true,
  },
  {
    id: "earnings_summary",
    method: "GET",
    path: "/earnings/summary",
    priceUsd: 0.02,
    stage: 0,
    mcpTool: "get_earnings_summary",
    summary: "Structured earnings summary from XBRL company facts (no PDF parsing).",
    available: true,
  },
  {
    id: "insiders",
    method: "GET",
    path: "/insiders",
    priceUsd: 0.01,
    stage: 1,
    mcpTool: "get_insider_transactions",
    summary: "Form 4 insider transactions for a ticker since a date.",
    available: true,
  },
  {
    id: "institutional",
    method: "GET",
    path: "/institutional",
    priceUsd: 0.02,
    stage: 1,
    mcpTool: "get_institutional_holdings",
    summary: "13F institutional holdings for a ticker and quarter.",
    available: false,
  },
  {
    id: "filings_extract",
    method: "POST",
    path: "/filings/extract",
    priceUsd: 0.04,
    stage: 1,
    mcpTool: "extract_filing_section",
    summary:
      "Extract a normalized section (risk factors, MD&A, revenue/segment tables) from a 10-K/10-Q.",
    available: false,
  },
  {
    id: "search",
    method: "POST",
    path: "/search",
    priceUsd: 0.03,
    stage: 2,
    mcpTool: "search_filings",
    summary: "Semantic search over filing sections.",
    available: false,
  },
] as const;

/** Approved pricing band (handoff §4). Changes outside this require escalation. */
export const PRICE_BAND_USD = { min: 0.01, max: 0.05 } as const;

/**
 * The flat monthly subscription — the second payment rail, alongside x402.
 *
 * Rationale (2026-07-26): every vendor observed collecting real money for SEC data
 * does it through a card-billed subscription (sec-api.io $49–239/mo, edgar.tools
 * $24.99/mo). Nothing has been observed collecting meaningful money per-call over
 * crypto. x402 stays enabled — it costs nothing to leave running and is the only
 * rail an unattended agent can use without a human first creating an account — but
 * this is the rail a human buyer can actually reach, self-serve, with a card.
 *
 * Priced under the cheapest incumbent deliberately: the wedge is correctness, not
 * coverage, and a lone operator cannot win a breadth comparison against sec-api.io.
 */
export const SUBSCRIPTION = {
  id: "unlimited_monthly",
  priceUsdPerMonth: 19,
  name: "AgentFilings Unlimited",
  summary:
    "Unlimited calls to every paid endpoint and MCP tool for a flat monthly price, " +
    "authenticated with an API key instead of a per-call payment.",
  /** Soft ceiling for abuse control, not a metered quota. Well above any honest use. */
  fairUseCallsPerDay: 50_000,
} as const;

export function endpointById(id: string): EndpointSpec | undefined {
  return ENDPOINTS.find((e) => e.id === id);
}

export function paidEndpoints(): EndpointSpec[] {
  return ENDPOINTS.filter((e) => e.priceUsd > 0);
}

/**
 * Paid endpoints that are implemented and can actually serve a response.
 *
 * This is what the payment layer must gate on. Charging for a route with no handler
 * takes the agent's money and then 404s.
 */
export function payableEndpoints(): EndpointSpec[] {
  return ENDPOINTS.filter((e) => e.priceUsd > 0 && e.available);
}

export function freeEndpoints(): EndpointSpec[] {
  return ENDPOINTS.filter((e) => e.priceUsd === 0);
}
