import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Company,
  EarningsPeriod,
  Filing,
  InsiderTransaction,
  TickerCorpus,
} from "@agentfilings/shared";

export interface FilingsResult {
  company: Company;
  filings: Filing[];
  retrievedAt?: string;
}

export interface EarningsResult {
  company: Company;
  periods: EarningsPeriod[];
  retrievedAt?: string;
}

export interface InsiderResult {
  company: Company;
  transactions: InsiderTransaction[];
  retrievedAt?: string;
}

export interface Coverage {
  covered: number;
  lastIngestAt: string | null;
}

/** Per-ticker availability, so an agent can check BEFORE paying. */
export interface TickerCoverage {
  covered: boolean;
  company?: { cik: string; name: string };
  filings: number;
  earningsPeriods: number;
  insiderTransactions: number;
  lastUpdated: string | null;
}

/**
 * Reads the corpus. `null` return = ticker not covered. Async so a Postgres-backed
 * implementation (production) and the local-JSON implementation (dev) share the
 * interface; routes/services await it.
 */
export interface CorpusRepo {
  getLatestFilings(ticker: string, opts?: { form?: string; limit?: number }): Promise<FilingsResult | null>;
  getEarnings(ticker: string, opts?: { period?: string }): Promise<EarningsResult | null>;
  getInsiders(ticker: string, opts?: { since?: string }): Promise<InsiderResult | null>;
  getCoverage(): Promise<Coverage>;
  getTickerCoverage(ticker: string): Promise<TickerCoverage>;
}

export class LocalJsonCorpusRepo implements CorpusRepo {
  private cache = new Map<string, TickerCorpus | null>();

  constructor(private readonly baseDir: string) {}

  private load(ticker: string): TickerCorpus | null {
    const key = ticker.toUpperCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached; // includes negatively-cached null (not covered)

    const path = join(this.baseDir, `${key}.json`);
    if (!existsSync(path)) {
      this.cache.set(key, null);
      return null;
    }

    let corpus: TickerCorpus;
    try {
      corpus = JSON.parse(readFileSync(path, "utf8")) as TickerCorpus;
    } catch (cause) {
      throw new Error(`Corrupt corpus file for ${key}`, { cause });
    }
    this.cache.set(key, corpus);
    return corpus;
  }

  getLatestFilings(
    ticker: string,
    opts: { form?: string; limit?: number } = {},
  ): Promise<FilingsResult | null> {
    const corpus = this.load(ticker);
    if (!corpus) return Promise.resolve(null);
    let filings = corpus.filings; // SEC returns newest-first
    if (opts.form) filings = filings.filter((f) => f.form === opts.form);
    if (opts.limit !== undefined) filings = filings.slice(0, opts.limit);
    return Promise.resolve({
      company: corpus.company,
      filings,
      retrievedAt: corpus.meta?.retrieved_at,
    });
  }

  getEarnings(ticker: string, opts: { period?: string } = {}): Promise<EarningsResult | null> {
    const corpus = this.load(ticker);
    if (!corpus) return Promise.resolve(null);
    let periods = corpus.earnings; // newest period_end first
    const period = opts.period?.trim().toLowerCase();
    if (period === "annual" || period === "quarterly" || period === "interim") {
      periods = periods.filter((p) => p.duration === period);
    } else if (period && /^(fy)?\d{4}$/.test(period)) {
      const year = Number(period.replace("fy", ""));
      periods = periods.filter((p) => p.fiscal_year === year);
    } else if (period) {
      periods = periods.filter((p) => p.frame?.toLowerCase() === period);
    }
    return Promise.resolve({
      company: corpus.company,
      periods,
      retrievedAt: corpus.meta?.retrieved_at,
    });
  }

  getInsiders(ticker: string, opts: { since?: string } = {}): Promise<InsiderResult | null> {
    const corpus = this.load(ticker);
    if (!corpus) return Promise.resolve(null);
    let transactions = corpus.insiders ?? [];
    if (opts.since) {
      const since = opts.since;
      transactions = transactions.filter((t) => (t.transaction_date ?? "") >= since);
    }
    return Promise.resolve({
      company: corpus.company,
      transactions,
      retrievedAt: corpus.meta?.retrieved_at,
    });
  }

  getTickerCoverage(ticker: string): Promise<TickerCoverage> {
    const corpus = this.load(ticker);
    if (!corpus) {
      return Promise.resolve({
        covered: false,
        filings: 0,
        earningsPeriods: 0,
        insiderTransactions: 0,
        lastUpdated: null,
      });
    }
    return Promise.resolve({
      covered: true,
      company: { cik: corpus.company.cik, name: corpus.company.name },
      filings: corpus.filings.length,
      earningsPeriods: corpus.earnings.length,
      insiderTransactions: corpus.insiders?.length ?? 0,
      lastUpdated: corpus.meta?.retrieved_at ?? null,
    });
  }

  getCoverage(): Promise<Coverage> {
    if (!existsSync(this.baseDir)) return Promise.resolve({ covered: 0, lastIngestAt: null });
    const files = readdirSync(this.baseDir).filter((f) => f.toLowerCase().endsWith(".json"));
    let last: string | null = null;
    for (const file of files) {
      const corpus = this.load(file.replace(/\.json$/i, ""));
      const retrieved = corpus?.meta?.retrieved_at ?? null;
      if (retrieved && (!last || retrieved > last)) last = retrieved;
    }
    return Promise.resolve({ covered: files.length, lastIngestAt: last });
  }
}
