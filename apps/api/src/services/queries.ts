import type { Company, EarningsPeriod, Filing, InsiderTransaction } from "@agentfilings/shared";
import type { CorpusRepo } from "../repo/corpus-repo";

// Shared query logic used by BOTH the HTTP routes and the MCP tools, so validation,
// normalization, and error codes live in one place.

export type QueryResult<T> =
  | { ok: true; sourceApi: string; data: T }
  | { ok: false; code: "bad_request" | "coverage_missing"; message: string };

export interface AgentFilings {
  ticker: string;
  company: Company;
  count: number;
  filings: Filing[];
  as_of: string | null;
}

export interface EarningsData {
  ticker: string;
  company: Company;
  period: string | null;
  count: number;
  periods: EarningsPeriod[];
  as_of: string | null;
}

export interface InsiderData {
  ticker: string;
  company: Company;
  since: string | null;
  count: number;
  transactions: InsiderTransaction[];
  as_of: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function queryLatestFilings(
  repo: CorpusRepo,
  params: { ticker?: string; form?: string; limit?: number | string },
): Promise<QueryResult<AgentFilings>> {
  const ticker = params.ticker?.trim().toUpperCase();
  if (!ticker) {
    return { ok: false, code: "bad_request", message: "Missing required parameter: ticker." };
  }
  const form =
    typeof params.form === "string" ? params.form.trim().toUpperCase() || undefined : undefined;

  let limit = 20;
  if (params.limit !== undefined && params.limit !== "") {
    limit = Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return { ok: false, code: "bad_request", message: "limit must be an integer between 1 and 100." };
    }
  }

  const result = await repo.getLatestFilings(ticker, { form, limit });
  if (!result) {
    return { ok: false, code: "coverage_missing", message: `No coverage for ticker ${ticker}.` };
  }
  return {
    ok: true,
    sourceApi: "sec-edgar-submissions",
    data: {
      ticker,
      company: result.company,
      count: result.filings.length,
      filings: result.filings,
      as_of: result.retrievedAt ?? null,
    },
  };
}

export async function queryEarningsSummary(
  repo: CorpusRepo,
  params: { ticker?: string; period?: string },
): Promise<QueryResult<EarningsData>> {
  const ticker = params.ticker?.trim().toUpperCase();
  if (!ticker) {
    return { ok: false, code: "bad_request", message: "Missing required parameter: ticker." };
  }
  const period = params.period?.trim() || undefined;

  const result = await repo.getEarnings(ticker, { period });
  if (!result) {
    return { ok: false, code: "coverage_missing", message: `No coverage for ticker ${ticker}.` };
  }
  return {
    ok: true,
    sourceApi: "sec-edgar-companyfacts",
    data: {
      ticker,
      company: result.company,
      period: period ?? null,
      count: result.periods.length,
      periods: result.periods,
      as_of: result.retrievedAt ?? null,
    },
  };
}

export async function queryInsiders(
  repo: CorpusRepo,
  params: { ticker?: string; since?: string },
): Promise<QueryResult<InsiderData>> {
  const ticker = params.ticker?.trim().toUpperCase();
  if (!ticker) {
    return { ok: false, code: "bad_request", message: "Missing required parameter: ticker." };
  }
  const since = params.since?.trim() || undefined;
  if (since && !ISO_DATE.test(since)) {
    return { ok: false, code: "bad_request", message: "since must be a date (YYYY-MM-DD)." };
  }

  const result = await repo.getInsiders(ticker, { since });
  if (!result) {
    return { ok: false, code: "coverage_missing", message: `No coverage for ticker ${ticker}.` };
  }
  return {
    ok: true,
    sourceApi: "sec-edgar-form4",
    data: {
      ticker,
      company: result.company,
      since: since ?? null,
      count: result.transactions.length,
      transactions: result.transactions,
      as_of: result.retrievedAt ?? null,
    },
  };
}
