import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { endpointById, ENDPOINTS, PRICE_BAND_USD } from "@agentfilings/shared";
import { z } from "zod";
import type { CorpusRepo, TickerCoverage } from "../repo/corpus-repo";
import { queryEarningsSummary, queryInsiders, queryLatestFilings } from "../services/queries";
import type { McpPaidWrapper } from "./payments";

// MCP server (handoff §6). Tools mirror the paid endpoints 1:1 and state their price
// in the description (agents need pre-call cost visibility), plus the free
// probe_coverage. Handlers reuse the same query service as the HTTP routes.
//
// When x402 is enabled, paid tools are wrapped with @x402/mcp (shared resource server
// + replay guard); unwrapped in dev.

const VERSION = "0.0.0";

// Per-tool data availability. A company can be covered for filings and empty for
// earnings (IFRS filers, pre-revenue companies), so the probe must say which tools
// will actually return something rather than a blanket "covered".
const TOOL_DATASETS: { tool: string; count: (c: TickerCoverage) => number }[] = [
  { tool: "get_latest_filings", count: (c) => c.filings },
  { tool: "get_earnings_summary", count: (c) => c.earningsPeriods },
  { tool: "get_insider_transactions", count: (c) => c.insiderTransactions },
];

const toolsWithData = (c: TickerCoverage): string[] =>
  c.covered ? TOOL_DATASETS.filter((d) => d.count(c) > 0).map((d) => d.tool) : [];

const emptyTools = (c: TickerCoverage): string[] =>
  c.covered ? TOOL_DATASETS.filter((d) => d.count(c) === 0).map((d) => d.tool) : [];

function coverageHint(c: TickerCoverage): string {
  if (!c.covered) return "Not covered. Paid tools return no data for this ticker; do not pay.";
  const has = toolsWithData(c);
  const empty = emptyTools(c);
  if (empty.length === 0) return "Covered. All paid tools will return data.";
  if (has.length === 0) return "Known company, but no data loaded for any paid tool yet; do not pay.";
  return (
    `Partial coverage. ${has.join(" and ")} will return data. ` +
    `${empty.join(" and ")} would return an empty result, so do not pay for those.`
  );
}

interface ToolReply {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  // Matches the MCP SDK's CallToolResult, which carries an index signature.
  [key: string]: unknown;
}

function priceOf(id: string): number {
  return endpointById(id)?.priceUsd ?? 0;
}

function priceLabel(id: string): string {
  const usd = priceOf(id);
  return usd > 0
    ? `Price: $${usd.toFixed(2)} per call (x402 USDC on Base, or a Stripe API key).`
    : "Free.";
}

function jsonResult(data: unknown): ToolReply {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorResult(code: string, message: string): ToolReply {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: { code, message, hint: "Call probe_coverage for coverage and pricing." },
        }),
      },
    ],
    isError: true,
  };
}

/** Gate a paid tool handler behind x402 payment when a wrapper is configured. */
function gate<A extends Record<string, unknown>>(
  wrapPaid: McpPaidWrapper | undefined,
  endpointId: string,
  toolName: string,
  handler: (args: A) => Promise<ToolReply>,
): (args: A) => Promise<ToolReply> {
  if (!wrapPaid) return handler;
  const ep = endpointById(endpointId);
  // @x402/mcp's MCPToolCallback is registerTool-compatible; the wrapper reads the
  // payment from _meta, verifies + settles (through the shared resource server + guard
  // extension), then calls our handler. The cast bridges the SDK generic; the runtime
  // contract holds.
  const wrapped = wrapPaid(priceOf(endpointId), toolName, ep?.summary ?? toolName)(
    (args) => handler(args as A),
  );
  return wrapped as unknown as (args: A) => Promise<ToolReply>;
}

export function createMcpServer(repo: CorpusRepo, wrapPaid?: McpPaidWrapper): McpServer {
  const server = new McpServer({ name: "agentfilings", version: VERSION });

  server.registerTool(
    "probe_coverage",
    {
      title: "Check coverage and pricing (free)",
      description:
        "FREE — no payment required. Call this FIRST to check whether a ticker is " +
        "covered and what it will cost before spending anything. Returns whether the " +
        "company is in the corpus, how much data exists (filings / earnings periods / " +
        "insider transactions), how fresh it is, and the exact price of every paid tool. " +
        "If a ticker is not covered, the paid tools return no data — so check here " +
        "instead of paying to find out.",
      inputSchema: {
        ticker: z.string().optional().describe("Ticker to check, e.g. AAPL. Omit for service-wide coverage."),
      },
    },
    async ({ ticker }) => {
      const symbol = ticker?.trim().toUpperCase() || null;
      const [coverage, tickerCoverage] = await Promise.all([
        repo.getCoverage(),
        symbol ? repo.getTickerCoverage(symbol) : Promise.resolve(null),
      ]);
      return jsonResult({
        service: "agentfilings",
        ticker: symbol,
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
              // Be precise: a company can have filings but no earnings (IFRS filers,
              // pre-revenue companies). Saying "covered" flatly would invite an agent
              // to pay for an empty result.
              tools_with_data: toolsWithData(tickerCoverage),
              empty_tools: emptyTools(tickerCoverage),
              hint: coverageHint(tickerCoverage),
            }
          : null,
        coverage: {
          // Not a fixed index — see the note in routes/probe.ts. Naming one would
          // make an agent skip tickers that are actually covered.
          universe: "US public companies filing with SEC EDGAR",
          companies_covered: coverage.covered,
          source: "SEC EDGAR (public domain)",
        },
        freshness: { last_ingest_at: coverage.lastIngestAt, cadence: "twice daily" },
        pricing: ENDPOINTS.filter((e) => e.mcpTool && e.available).map((e) => ({
          tool: e.mcpTool,
          price_usd: e.priceUsd,
          stage: e.stage,
          summary: e.summary,
        })),
        price_band_usd: PRICE_BAND_USD,
      });
    },
  );

  server.registerTool(
    "get_latest_filings",
    {
      title: "Get latest filings",
      description:
        "Latest SEC filings for a US public company, as structured JSON: form type, " +
        "filing date, period, accession number, and a direct link to the document. " +
        "Pre-indexed, so this is one fast call instead of crawling EDGAR and parsing " +
        "its index pages. Use it to answer 'what has this company filed recently?' or " +
        "to locate a specific 10-K/10-Q/8-K before reading it. " +
        `${priceLabel("filings_latest")} Check coverage first with probe_coverage (free).`,
      inputSchema: {
        ticker: z.string().describe("Ticker symbol, e.g. AAPL"),
        form: z.string().optional().describe("Form type filter, e.g. 10-K, 10-Q, 8-K, 4"),
        limit: z.number().int().min(1).max(100).optional().describe("Max filings (default 20)"),
      },
    },
    gate(wrapPaid, "filings_latest", "get_latest_filings", async ({ ticker, form, limit }) => {
      const result = await queryLatestFilings(repo, { ticker, form, limit });
      return result.ok ? jsonResult(result.data) : errorResult(result.code, result.message);
    }),
  );

  server.registerTool(
    "get_earnings_summary",
    {
      title: "Get earnings summary",
      description:
        "Revenue, net income, and basic/diluted EPS by fiscal period for a US public " +
        "company, normalized from SEC XBRL data. Handles the parts that are easy to get " +
        "wrong: revenue tags changed over time, restated figures are reconciled to the " +
        "latest value, and each period keeps the fiscal year/quarter from its ORIGINAL " +
        "filing (prior-year comparatives inside later filings do not corrupt the labels). " +
        "Every period carries its source accession number and filing date. " +
        "Use it for trend analysis, growth rates, or a specific quarter's results. " +
        `${priceLabel("earnings_summary")} Check coverage first with probe_coverage (free).`,
      inputSchema: {
        ticker: z.string().describe("Ticker symbol, e.g. AAPL"),
        period: z
          .string()
          .optional()
          .describe('Filter: "annual" | "quarterly" | "interim" | fiscal year (2025/FY2025) | frame (CY2026Q1)'),
      },
    },
    gate(wrapPaid, "earnings_summary", "get_earnings_summary", async ({ ticker, period }) => {
      const result = await queryEarningsSummary(repo, { ticker, period });
      return result.ok ? jsonResult(result.data) : errorResult(result.code, result.message);
    }),
  );

  server.registerTool(
    "get_insider_transactions",
    {
      title: "Get insider transactions",
      description:
        "Form 4 insider transactions for a US public company: who traded, their role " +
        "(director/officer/10% owner), transaction code, share count, price, and shares " +
        "held afterwards. Parsed from the raw ownership XML, including derivative " +
        "transactions, so you get structured rows instead of one XML document per trade. " +
        "Use it to detect insider buying/selling activity or check a specific executive. " +
        `${priceLabel("insiders")} Check coverage first with probe_coverage (free).`,
      inputSchema: {
        ticker: z.string().describe("Ticker symbol, e.g. AAPL"),
        since: z.string().optional().describe("Only transactions on/after this date (YYYY-MM-DD)"),
      },
    },
    gate(wrapPaid, "insiders", "get_insider_transactions", async ({ ticker, since }) => {
      const result = await queryInsiders(repo, { ticker, since });
      return result.ok ? jsonResult(result.data) : errorResult(result.code, result.message);
    }),
  );

  return server;
}

