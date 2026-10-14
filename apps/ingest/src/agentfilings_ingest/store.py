"""Write a corpus into Postgres. Idempotent per ticker: the company is upserted;
filings, earnings, and insider rows are replaced (delete + insert) in one transaction,
so re-running a ticker converges rather than duplicating."""

from __future__ import annotations

import os
from typing import Any

import psycopg


def connect(dsn: str | None = None) -> psycopg.Connection:
    dsn = dsn or os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is required to write to Postgres.")
    # prepare_threshold=None disables prepared statements. Supabase's transaction
    # pooler (pgbouncer, port 6543) multiplexes server connections, so a prepared
    # statement name from an earlier transaction collides:
    # "DuplicatePreparedStatement: prepared statement _pg3_0 already exists".
    # (Mirrors `prepare: false` on the TypeScript side.)
    return psycopg.connect(dsn, prepare_threshold=None)


def tracked_tickers(conn: psycopg.Connection) -> list[tuple[str, str]]:
    """(ticker, cik) already in the corpus — what the scheduled refresh re-syncs.

    The stored CIK is authoritative: re-resolving via SEC's ticker map could regress a
    company onto a post-reorganization shell that claims the same ticker.
    """
    with conn.cursor() as cur:
        cur.execute(
            "select ticker, cik from companies where ticker is not null order by ticker"
        )
        return [(row[0], row[1]) for row in cur.fetchall()]


def stale_tickers(
    conn: psycopg.Connection, max_age_hours: int, limit: int | None
) -> list[tuple[str, str]]:
    """The `limit` least-recently-synced tickers older than `max_age_hours`.

    A scheduled run has a fixed time budget, so it must take a *bounded slice* rather
    than the whole corpus. Ordering oldest-first makes consecutive runs pick up where
    the last left off, so the corpus round-robins to completion.

    This replaces an unbounded `tracked_tickers` refresh, which could not finish: at
    ~39 SEC requests per ticker and 10 req/s, 2,800 tickers need ~3 hours. Every run
    was killed partway through the alphabet, so the same prefix was re-synced twice a
    day and the rest of the corpus was never reached at all.

    A ticker that fails keeps its old timestamp and is retried next run. That is right
    for transient failures, but a permanently broken ticker will occupy a slot every
    run — `sync_tickers` reports failures so they do not stay invisible.
    """
    return _select_stale(conn, "updated_at", max_age_hours, limit)


def stale_insider_tickers(
    conn: psycopg.Connection, max_age_hours: int, limit: int | None
) -> list[tuple[str, str]]:
    """Same, but ordered by when Form 4 data was last fetched.

    Insider data needs its own clock because it is ~20x more expensive to refresh than
    company metadata (up to 50 Form 4 documents per ticker, versus two API calls), so
    the two run on different cadences. Sharing `updated_at` would let the cheap daily
    pass mark every row fresh and starve the insider rotation permanently.

    Rows never fetched sort first, so a corpus backfilled without insiders fills in.
    """
    return _select_stale(conn, "insiders_updated_at", max_age_hours, limit)


def _select_stale(
    conn: psycopg.Connection, column: str, max_age_hours: int, limit: int | None
) -> list[tuple[str, str]]:
    # `column` is never caller-supplied — it is one of two literals chosen above — so
    # interpolating it cannot carry untrusted input. Values stay parameterized.
    assert column in ("updated_at", "insiders_updated_at"), column
    with conn.cursor() as cur:
        cur.execute(
            f"""
            select ticker, cik from companies
            where ticker is not null
              and ({column} is null or {column} < now() - (%s * interval '1 hour'))
            order by {column} asc nulls first, ticker
            limit %s
            """,
            (max_age_hours, limit),
        )
        return [(row[0], row[1]) for row in cur.fetchall()]


def count_stale(conn: psycopg.Connection, column: str, max_age_hours: int) -> int:
    """How many tickers are eligible — used to report progress through a rotation."""
    assert column in ("updated_at", "insiders_updated_at"), column
    with conn.cursor() as cur:
        cur.execute(
            f"""
            select count(*) from companies
            where ticker is not null
              and ({column} is null or {column} < now() - (%s * interval '1 hour'))
            """,
            (max_age_hours,),
        )
        return int(cur.fetchone()[0])


def _rows(items: list[dict[str, Any]], cik: str, keys: tuple[str, ...]) -> list[tuple[Any, ...]]:
    return [tuple((cik if k == "cik" else item.get(k)) for k in keys) for item in items]


def write_corpus(conn: psycopg.Connection, corpus: dict[str, Any]) -> None:
    company = corpus["company"]
    cik = company["cik"]

    with conn.transaction(), conn.cursor() as cur:
        # A ticker must map to exactly one company. After a holding-company
        # reorganization two CIKs claim the same ticker (the shell and the real
        # entity), and the API resolves by ticker — so a leftover row could shadow the
        # right one non-deterministically. Drop any other CIK holding this ticker.
        if company.get("ticker"):
            cur.execute(
                "delete from companies where ticker = %s and cik <> %s",
                (company["ticker"], cik),
            )

        # Advance the insider clock only on runs that actually fetched Form 4 data, so
        # the cheap metadata pass cannot mark insider data fresh that it never touched.
        fetched_insiders = corpus.get("insiders") is not None
        cur.execute(
            """
            insert into companies (cik, ticker, name, sic, sic_description, exchanges,
                                   updated_at, insiders_updated_at)
            values (%(cik)s, %(ticker)s, %(name)s, %(sic)s, %(sic_description)s,
                    %(exchanges)s, now(),
                    case when %(fetched_insiders)s then now() end)
            on conflict (cik) do update set
              ticker = excluded.ticker,
              name = excluded.name,
              sic = excluded.sic,
              sic_description = excluded.sic_description,
              exchanges = excluded.exchanges,
              updated_at = now(),
              insiders_updated_at = case
                when %(fetched_insiders)s then now()
                else companies.insiders_updated_at
              end
            """,
            {**company, "fetched_insiders": fetched_insiders},
        )

        filing_keys = (
            "accession_no", "cik", "form", "filed_at", "period", "primary_doc", "primary_doc_url",
        )
        cur.execute("delete from filings where cik = %s", (cik,))
        if corpus["filings"]:
            cur.executemany(
                "insert into filings (accession_no, cik, form, filed_at, period, primary_doc, "
                "primary_doc_url) values (%s, %s, %s, %s, %s, %s, %s) "
                "on conflict (accession_no) do nothing",
                _rows(corpus["filings"], cik, filing_keys),
            )

        earnings_keys = (
            "cik", "period_start", "period_end", "duration", "fiscal_year", "fiscal_period",
            "frame", "revenue", "net_income", "eps_basic", "eps_diluted", "form", "filed_at",
            "source_accession",
        )
        cur.execute("delete from earnings_periods where cik = %s", (cik,))
        if corpus["earnings"]:
            cur.executemany(
                "insert into earnings_periods (cik, period_start, period_end, duration, "
                "fiscal_year, fiscal_period, frame, revenue, net_income, eps_basic, eps_diluted, "
                "form, filed_at, source_accession) "
                "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                _rows(corpus["earnings"], cik, earnings_keys),
            )

        insider_keys = (
            "cik", "filed_at", "accession_no", "owner_name", "owner_cik", "relationship",
            "officer_title", "transaction_date", "code", "security", "shares", "price",
            "acquired_disposed", "shares_owned_after", "derivative",
        )
        # `insiders: None` means "this run did not fetch insider data" — leave existing
        # rows alone. Only an actual list replaces them. Without this distinction a
        # fundamentals-only backfill silently deletes previously ingested Form 4 data.
        insiders = corpus.get("insiders")
        if insiders is None:
            return

        cur.execute("delete from insider_transactions where cik = %s", (cik,))
        if insiders:
            cur.executemany(
                "insert into insider_transactions (cik, filed_at, accession_no, owner_name, "
                "owner_cik, relationship, officer_title, transaction_date, code, security, shares, "
                "price, acquired_disposed, shares_owned_after, derivative) "
                "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                _rows(insiders, cik, insider_keys),
            )
