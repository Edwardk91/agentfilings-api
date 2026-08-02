import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

// Bazaar discovery declarations (handoff §5.1).
//
// Without these, a paid route settles but the catalog has nothing to show: no input
// schema, no example output. Agents choosing between services see an opaque URL and a
// price. These declarations are the listing copy — they tell a catalog (and the agent
// reading it) exactly how to call the endpoint and what comes back.
//
// Examples are real response shapes, trimmed. Anything inaccurate here trains agents
// to call the endpoint wrong and burn a payment on a 400.

export const SERVICE_NAME = "AgentFilings";
export const SERVICE_TAGS = ["sec", "edgar", "filings", "earnings", "insider-trading"];

const META_EXAMPLE = {
  source_api: "sec-edgar-submissions",
  retrieved_at: "2026-07-26T01:35:41Z",
  cache: "miss",
};

/** Discovery declaration per endpoint id. Only implemented endpoints belong here. */
export const DISCOVERY_BY_ENDPOINT: Record<string, Record<string, unknown>> = {
  filings_latest: declareDiscoveryExtension({
    input: { ticker: "AAPL", form: "10-Q", limit: 5 },
    inputSchema: {
      properties: {
        ticker: { type: "string", description: "Ticker symbol, e.g. AAPL" },
        form: {
          type: "string",
          description: "Optional SEC form filter, e.g. 10-K, 10-Q, 8-K, 4",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Max filings to return (default 20)",
        },
      },
      required: ["ticker"],
    },
    output: {
      example: {
        data: {
          ticker: "AAPL",
          company: { cik: "0000320193", ticker: "AAPL", name: "Apple Inc." },
          count: 1,
          filings: [
            {
              accession_no: "0000320193-26-000013",
              form: "10-Q",
              filed_at: "2026-05-01",
              period: "2026-03-28",
              primary_doc_url:
                "https://www.sec.gov/Archives/edgar/data/320193/000032019326000013/aapl-20260328.htm",
            },
          ],
        },
        meta: META_EXAMPLE,
      },
    },
  }),

  earnings_summary: declareDiscoveryExtension({
    input: { ticker: "AAPL", period: "quarterly" },
    inputSchema: {
      properties: {
        ticker: { type: "string", description: "Ticker symbol, e.g. AAPL" },
        period: {
          type: "string",
          description:
            'Optional filter: "annual" | "quarterly" | "interim", a fiscal year ("2025" or "FY2025"), or an SEC frame ("CY2026Q1")',
        },
      },
      required: ["ticker"],
    },
    output: {
      example: {
        data: {
          ticker: "AAPL",
          count: 1,
          periods: [
            {
              period_start: "2025-12-28",
              period_end: "2026-03-28",
              duration: "quarterly",
              fiscal_year: 2026,
              fiscal_period: "Q2",
              revenue: 111184000000,
              net_income: 29578000000,
              eps_basic: 2.02,
              eps_diluted: 2.01,
              form: "10-Q",
              filed_at: "2026-05-01",
              source_accession: "0000320193-26-000013",
            },
          ],
        },
        meta: { ...META_EXAMPLE, source_api: "sec-edgar-companyfacts" },
      },
    },
  }),

  insiders: declareDiscoveryExtension({
    input: { ticker: "AAPL", since: "2026-01-01" },
    inputSchema: {
      properties: {
        ticker: { type: "string", description: "Ticker symbol, e.g. AAPL" },
        since: {
          type: "string",
          description: "Optional ISO date (YYYY-MM-DD); only transactions on or after it",
        },
      },
      required: ["ticker"],
    },
    output: {
      example: {
        data: {
          ticker: "AAPL",
          count: 1,
          transactions: [
            {
              filed_at: "2026-06-17",
              accession_no: "0001140361-26-025622",
              owner_name: "Newstead Jennifer",
              relationship: ["officer"],
              officer_title: "SVP, GC and Secretary",
              transaction_date: "2026-06-15",
              code: "M",
              security: "Common Stock",
              shares: 30104,
              price: null,
              acquired_disposed: "A",
              shares_owned_after: 57784,
              derivative: false,
            },
          ],
        },
        meta: { ...META_EXAMPLE, source_api: "sec-edgar-form4" },
      },
    },
  }),
};
