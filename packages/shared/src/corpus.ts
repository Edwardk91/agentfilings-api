// The per-ticker corpus shape. Produced by the Python ingestion (one JSON file per
// ticker under data/corpus/ for now; Postgres rows later) and consumed by the API.
// Keep in sync with apps/ingest/src/agentfilings_ingest/models.py.

export interface Company {
  cik: string; // 10-digit
  ticker: string | null;
  name: string;
  sic?: string | null;
  sic_description?: string | null;
  exchanges: string[];
}

export interface Filing {
  accession_no: string;
  form: string;
  filed_at: string; // YYYY-MM-DD
  period: string | null; // report date
  primary_doc: string | null;
  primary_doc_url: string | null;
}

export type PeriodDuration = "annual" | "quarterly" | "interim";

export interface EarningsPeriod {
  period_start: string;
  period_end: string;
  duration: PeriodDuration;
  fiscal_year: number | null;
  fiscal_period: string | null;
  frame: string | null;
  revenue: number | null;
  net_income: number | null;
  eps_basic: number | null;
  eps_diluted: number | null;
  form: string | null;
  filed_at: string | null;
  source_accession: string | null;
}

export interface InsiderTransaction {
  filed_at: string;
  accession_no: string;
  owner_name: string | null;
  owner_cik: string | null;
  relationship: string[]; // director | officer | 10% owner | other
  officer_title: string | null;
  transaction_date: string | null;
  code: string | null; // SEC transaction code (P, S, A, M, F, ...)
  security: string | null;
  shares: number | null;
  price: number | null; // null when disclosed only in a footnote
  acquired_disposed: string | null; // "A" | "D"
  shares_owned_after: number | null;
  derivative: boolean;
}

export interface TickerCorpus {
  company: Company;
  filings: Filing[];
  earnings: EarningsPeriod[];
  insiders?: InsiderTransaction[];
  meta: { source: string; retrieved_at?: string };
}
