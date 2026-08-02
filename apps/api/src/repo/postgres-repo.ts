import type { Company, EarningsPeriod, Filing, InsiderTransaction } from "@agentfilings/shared";
import postgres, { type Sql } from "postgres";
import type {
  Coverage,
  CorpusRepo,
  EarningsResult,
  FilingsResult,
  InsiderResult,
  TickerCoverage,
} from "./corpus-repo";

// Postgres-backed corpus (production). SELECTs cast dates to ::text and numerics to
// ::float8 so rows arrive in the exact shape of the shared types (postgres.js returns
// dates as Date and numerics as string by default).

interface CompanyRow {
  cik: string;
  ticker: string | null;
  name: string;
  sic: string | null;
  sic_description: string | null;
  exchanges: string[];
  updated_at: string;
}

export class PostgresCorpusRepo implements CorpusRepo {
  private readonly sql: Sql;

  constructor(connectionString: string) {
    // Supabase's transaction pooler (pgbouncer, port 6543) does not support prepared
    // statements — disable them.
    this.sql = postgres(connectionString, { prepare: false });
  }

  private async resolveCompany(
    ticker: string,
  ): Promise<{ cik: string; company: Company; retrievedAt: string } | null> {
    const rows = await this.sql<CompanyRow[]>`
      select cik, ticker, name, sic, sic_description, exchanges, updated_at::text
      from companies where ticker = ${ticker} limit 1`;
    const row = rows[0];
    if (!row) return null;
    const company: Company = {
      cik: row.cik,
      ticker: row.ticker,
      name: row.name,
      sic: row.sic,
      sic_description: row.sic_description,
      exchanges: row.exchanges,
    };
    return { cik: row.cik, company, retrievedAt: row.updated_at };
  }

  async getLatestFilings(
    ticker: string,
    opts: { form?: string; limit?: number } = {},
  ): Promise<FilingsResult | null> {
    const resolved = await this.resolveCompany(ticker);
    if (!resolved) return null;
    const limit = opts.limit ?? 20;
    const formFilter = opts.form ? this.sql`and form = ${opts.form}` : this.sql``;
    const filings = await this.sql<Filing[]>`
      select accession_no, form, filed_at::text, period::text, primary_doc, primary_doc_url
      from filings
      where cik = ${resolved.cik} ${formFilter}
      order by filed_at desc, accession_no desc
      limit ${limit}`;
    return { company: resolved.company, filings, retrievedAt: resolved.retrievedAt };
  }

  async getEarnings(
    ticker: string,
    opts: { period?: string } = {},
  ): Promise<EarningsResult | null> {
    const resolved = await this.resolveCompany(ticker);
    if (!resolved) return null;

    const period = opts.period?.trim().toLowerCase();
    let filter = this.sql``;
    if (period === "annual" || period === "quarterly" || period === "interim") {
      filter = this.sql`and duration = ${period}`;
    } else if (period && /^(fy)?\d{4}$/.test(period)) {
      filter = this.sql`and fiscal_year = ${Number(period.replace("fy", ""))}`;
    } else if (period) {
      filter = this.sql`and lower(frame) = ${period}`;
    }

    const periods = await this.sql<EarningsPeriod[]>`
      select period_start::text, period_end::text, duration, fiscal_year, fiscal_period, frame,
             revenue::float8, net_income::float8, eps_basic::float8, eps_diluted::float8,
             form, filed_at::text, source_accession
      from earnings_periods
      where cik = ${resolved.cik} ${filter}
      order by period_end desc, period_start desc`;
    return { company: resolved.company, periods, retrievedAt: resolved.retrievedAt };
  }

  async getInsiders(
    ticker: string,
    opts: { since?: string } = {},
  ): Promise<InsiderResult | null> {
    const resolved = await this.resolveCompany(ticker);
    if (!resolved) return null;
    const sinceFilter = opts.since ? this.sql`and transaction_date >= ${opts.since}` : this.sql``;
    const transactions = await this.sql<InsiderTransaction[]>`
      select filed_at::text, accession_no, owner_name, owner_cik, relationship, officer_title,
             transaction_date::text, code, security, shares::float8, price::float8,
             acquired_disposed, shares_owned_after::float8, derivative
      from insider_transactions
      where cik = ${resolved.cik} ${sinceFilter}
      order by transaction_date desc nulls last`;
    return { company: resolved.company, transactions, retrievedAt: resolved.retrievedAt };
  }

  async getTickerCoverage(ticker: string): Promise<TickerCoverage> {
    const rows = await this.sql<
      {
        cik: string;
        name: string;
        updated_at: string;
        filings: number;
        earnings: number;
        insiders: number;
      }[]
    >`
      select c.cik, c.name, c.updated_at::text,
             (select count(*)::int from filings f where f.cik = c.cik) as filings,
             (select count(*)::int from earnings_periods e where e.cik = c.cik) as earnings,
             (select count(*)::int from insider_transactions i where i.cik = c.cik) as insiders
      from companies c
      where c.ticker = ${ticker}
      limit 1`;
    const row = rows[0];
    if (!row) {
      return {
        covered: false,
        filings: 0,
        earningsPeriods: 0,
        insiderTransactions: 0,
        lastUpdated: null,
      };
    }
    return {
      covered: true,
      company: { cik: row.cik, name: row.name },
      filings: row.filings,
      earningsPeriods: row.earnings,
      insiderTransactions: row.insiders,
      lastUpdated: row.updated_at,
    };
  }

  async getCoverage(): Promise<Coverage> {
    const rows = await this.sql<{ covered: number; last: string | null }[]>`
      select count(*)::int as covered, max(updated_at)::text as last from companies`;
    const row = rows[0];
    return { covered: row?.covered ?? 0, lastIngestAt: row?.last ?? null };
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
