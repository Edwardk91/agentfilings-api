-- FilingsData core schema (handoff §3).
--
-- The server connects via the Postgres `postgres` role (through DATABASE_URL), which
-- bypasses RLS. RLS is enabled with NO policies so the auto-generated PostgREST/anon
-- API exposes nothing — agents reach data only through our own API, never Supabase.

create table if not exists companies (
  cik text primary key,                       -- 10-digit CIK
  ticker text,
  name text not null default '',
  sic text,
  sic_description text,
  exchanges text[] not null default '{}',
  updated_at timestamptz not null default now()
);
create index if not exists companies_ticker_idx on companies (ticker);

create table if not exists filings (
  accession_no text primary key,
  cik text not null references companies (cik) on delete cascade,
  form text not null,
  filed_at date not null,
  period date,
  primary_doc text,
  primary_doc_url text
);
create index if not exists filings_cik_filed_idx on filings (cik, filed_at desc);
create index if not exists filings_cik_form_idx on filings (cik, form);

-- Assembled earnings periods (the parser's output), not raw XBRL facts: fiscal identity
-- is anchored to the original filing (see companyfacts.py) and stored here directly.
create table if not exists earnings_periods (
  id bigint generated always as identity primary key,
  cik text not null references companies (cik) on delete cascade,
  period_start date not null,
  period_end date not null,
  duration text not null,                     -- annual | quarterly | interim
  fiscal_year int,
  fiscal_period text,
  frame text,
  revenue numeric,
  net_income numeric,
  eps_basic numeric,
  eps_diluted numeric,
  form text,
  filed_at date,
  source_accession text,
  unique (cik, period_start, period_end)
);
create index if not exists earnings_cik_end_idx on earnings_periods (cik, period_end desc);
create index if not exists earnings_cik_fy_idx on earnings_periods (cik, fiscal_year);

create table if not exists insider_transactions (
  id bigint generated always as identity primary key,
  cik text not null references companies (cik) on delete cascade,
  filed_at date not null,
  accession_no text not null,
  owner_name text,
  owner_cik text,
  relationship text[] not null default '{}',
  officer_title text,
  transaction_date date,
  code text,
  security text,
  shares numeric,
  price numeric,
  acquired_disposed text,
  shares_owned_after numeric,
  derivative boolean not null default false
);
create index if not exists insiders_cik_date_idx on insider_transactions (cik, transaction_date desc);

alter table companies enable row level security;
alter table filings enable row level security;
alter table earnings_periods enable row level security;
alter table insider_transactions enable row level security;
