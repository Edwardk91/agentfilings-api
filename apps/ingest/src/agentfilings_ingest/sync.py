"""CLI: fetch + parse a set of tickers into the local corpus.

    python -m agentfilings_ingest.sync --tickers AAPL,MSFT --out data/corpus

Requires SEC_CONTACT_EMAIL (the SEC client refuses to start without it). Rate limited
to <=10 req/s globally by the shared client.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import UTC, datetime
from typing import Any

import httpx

from .config import load_dotenv
from .corpus import build_corpus
from .form4 import parse_form4, raw_doc_name
from .models import InsiderTransaction
from .sec_client import SecClient
from .store import connect, tracked_tickers, write_corpus
from .tickers import load_ticker_map
from .universe import load_universe, normalize_ticker

SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
COMPANYFACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
ARCHIVE_DOC_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{doc}"

# Cap Form 4 fetches per ticker so backfill stays within the SEC rate budget.
INSIDER_FILING_LIMIT = 50


def fetch_insiders(
    client: SecClient, sub: dict[str, Any], limit: int = INSIDER_FILING_LIMIT
) -> list[dict[str, Any]]:
    """Fetch + parse recent Form 4 docs from the issuer's feed into flat insider rows."""
    cik_int = int(sub["cik"])
    recent = sub["filings"]["recent"]
    accessions = recent["accessionNumber"]

    rows: list[dict[str, Any]] = []
    fetched = 0
    for i in range(len(accessions)):
        if recent["form"][i] != "4" or fetched >= limit:
            if fetched >= limit:
                break
            continue
        primary = recent["primaryDocument"][i]
        if not primary:
            continue
        fetched += 1
        acc = accessions[i]
        url = ARCHIVE_DOC_URL.format(
            cik=cik_int, acc=acc.replace("-", ""), doc=raw_doc_name(primary)
        )
        try:
            form4 = parse_form4(client.get_bytes(url))
        except (httpx.HTTPError, ValueError, SyntaxError) as exc:
            print(f"  skip Form 4 {acc}: {exc}")
            continue

        filed_at = recent["filingDate"][i]
        for t in form4.transactions:
            rows.append(
                InsiderTransaction(
                    filed_at=filed_at,
                    accession_no=acc,
                    owner_name=form4.owner_name,
                    owner_cik=form4.owner_cik,
                    relationship=form4.relationship,
                    officer_title=form4.officer_title,
                    transaction_date=t.transaction_date,
                    code=t.code,
                    security=t.security,
                    shares=t.shares,
                    price=t.price,
                    acquired_disposed=t.acquired_disposed,
                    shares_owned_after=t.shares_owned_after,
                    derivative=t.derivative,
                ).to_dict()
            )

    rows.sort(key=lambda r: r.get("transaction_date") or "", reverse=True)
    return rows


def sync_tickers(
    tickers: list[str],
    out_dir: str | None = None,
    to_db: bool = False,
    insider_limit: int = INSIDER_FILING_LIMIT,
    cik_map: dict[str, str] | None = None,
) -> int:
    """Sync each ticker. Returns the number that failed.

    `cik_map` supplies authoritative CIKs (from the universe list); when a ticker is
    present there we skip SEC's ambiguous ticker->CIK lookup entirely.

    One ticker failing must not abort the run — a scheduled refresh should still
    update everything else and report what broke.
    """
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    conn = connect() if to_db else None
    cik_map = cik_map or {}
    ok = 0
    failures: list[str] = []
    skipped: list[str] = []
    try:
        with SecClient() as client:
            # Only needed for tickers without an authoritative CIK.
            ticker_map = load_ticker_map(client) if any(t not in cik_map for t in tickers) else {}
            for raw in tickers:
                ticker = raw.strip().upper()
                if not ticker:
                    continue
                cik = cik_map.get(ticker)
                if cik is None:
                    company = ticker_map.get(ticker)
                    if company is None:
                        print(f"FAILED {ticker}: not found in SEC ticker map")
                        failures.append(f"{ticker} (not in SEC ticker map)")
                        continue
                    cik = company.cik

                try:
                    sub = client.get_json(SUBMISSIONS_URL.format(cik=cik))
                    facts = client.get_json(COMPANYFACTS_URL.format(cik=cik))

                    # An entity with no XBRL facts is almost always a post-reorganization
                    # shell that inherited the ticker (see universe.py). Recording it
                    # would advertise coverage we cannot actually serve, so refuse.
                    if not facts.get("facts", {}).get("us-gaap"):
                        print(
                            f"SKIP {ticker} (CIK {cik}): no us-gaap XBRL facts — likely a "
                            f"reorganization shell; not recording coverage"
                        )
                        skipped.append(ticker)
                        continue

                    corpus = build_corpus(sub, facts)
                    # None (not []) when disabled: preserves existing insider rows
                    # instead of replacing them with nothing.
                    corpus["insiders"] = (
                        fetch_insiders(client, sub, limit=insider_limit) if insider_limit else None
                    )
                    corpus["meta"]["retrieved_at"] = datetime.now(UTC).isoformat()

                    dest: list[str] = []
                    if conn is not None:
                        write_corpus(conn, corpus)
                        dest.append("postgres")
                    if out_dir:
                        path = os.path.join(out_dir, f"{ticker}.json")
                        with open(path, "w", encoding="utf-8") as f:
                            json.dump(corpus, f, indent=2)
                        dest.append(path)

                    ok += 1
                    insider_note = (
                        "insiders unchanged"
                        if corpus["insiders"] is None
                        else f"{len(corpus['insiders'])} insider transactions"
                    )
                    print(
                        f"{ticker}: {len(corpus['filings'])} filings, "
                        f"{len(corpus['earnings'])} earnings periods, "
                        f"{insider_note} -> {', '.join(dest)}"
                    )
                except Exception as exc:  # noqa: BLE001 - keep going, report at the end
                    failures.append(f"{ticker} ({type(exc).__name__})")
                    print(f"FAILED {ticker}: {type(exc).__name__}: {exc}")
    finally:
        if conn is not None:
            conn.close()

    # Name the casualties: a scheduled run reporting only a count is not actionable,
    # and log tails get truncated, so put the detail in the final line.
    print(
        f"\nsynced {ok} ticker(s), {len(failures)} failed, "
        f"{len(skipped)} skipped (no XBRL facts)"
    )
    if skipped:
        print(f"  skipped: {', '.join(skipped)}")
    if failures:
        print(f"  FAILED: {', '.join(failures)}")
    return len(failures)


def main() -> None:
    load_dotenv()  # repo-root .env for local runs; real env vars always win
    parser = argparse.ArgumentParser(description="Sync SEC data into the AgentFilings corpus.")
    parser.add_argument("--tickers", help="comma-separated, e.g. AAPL,MSFT")
    parser.add_argument(
        "--refresh-tracked",
        action="store_true",
        help="re-sync every ticker already in the database (used by the scheduled job)",
    )
    parser.add_argument(
        "--universe",
        help=(
            "backfill a named universe: 'sp500' (curated list with authoritative CIKs) "
            "or 'all' (every ticker in SEC's map). For 'all' there is no curated CIK "
            "source, so SEC's ambiguous ticker->CIK mapping is used; the no-XBRL-facts "
            "guard skips reorganization shells rather than recording empty coverage."
        ),
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="with --universe, skip tickers already in the database (resumable backfill)",
    )
    parser.add_argument(
        "--insider-limit",
        type=int,
        default=INSIDER_FILING_LIMIT,
        help=(
            "max Form 4 documents to fetch per ticker (0 disables). Each one is an extra "
            f"SEC request, so lower this for large backfills. Default {INSIDER_FILING_LIMIT}."
        ),
    )
    parser.add_argument(
        "--out", default=None, help="JSON output dir (default data/corpus unless --db)"
    )
    parser.add_argument("--db", action="store_true", help="write to Postgres via DATABASE_URL")
    args = parser.parse_args()

    if not args.tickers and not args.refresh_tracked and not args.universe:
        parser.error("pass --tickers, --refresh-tracked, or --universe")

    cik_map: dict[str, str] = {}

    if args.refresh_tracked:
        conn = connect()
        try:
            tracked = tracked_tickers(conn)
        finally:
            conn.close()
        if not tracked:
            print("no tracked tickers in the database — nothing to refresh")
            return
        cik_map = {t: c for t, c in tracked}
        tickers = [t for t, _ in tracked]
        print(f"refreshing {len(tickers)} tracked ticker(s)")
    elif args.universe:
        if args.universe == "all":
            # SEC's own map is the only source that covers the full filer universe.
            with SecClient() as client:
                full = load_ticker_map(client)
            cik_map = {t: c.cik for t, c in full.items()}
            tickers = sorted(cik_map)
            print(f"SEC ticker map: {len(tickers)} tickers")
        else:
            entries = load_universe(args.universe)
            cik_map = {e.ticker: e.cik for e in entries}
            tickers = [e.ticker for e in entries]
        if args.skip_existing:
            conn = connect()
            try:
                have = tracked_tickers(conn)
            finally:
                conn.close()
            have_tickers = {t for t, _ in have}
            before = len(tickers)
            tickers = [t for t in tickers if t not in have_tickers]
            print(
                f"universe {args.universe}: {before} tickers, "
                f"{before - len(tickers)} already present"
            )
        print(f"backfilling {len(tickers)} ticker(s) from universe '{args.universe}'")
    else:
        tickers = [normalize_ticker(t) for t in args.tickers.split(",")]

    out_dir = args.out
    if out_dir is None and not args.db and not args.refresh_tracked and not args.universe:
        out_dir = "data/corpus"  # default when not writing to the database
    to_db = args.db or args.refresh_tracked or bool(args.universe)

    failed = sync_tickers(
        tickers,
        out_dir=out_dir,
        to_db=to_db,
        insider_limit=args.insider_limit,
        cik_map=cik_map,
    )
    if failed:
        # Non-zero exit so a scheduled run surfaces as a failure instead of passing quietly.
        raise SystemExit(1)


if __name__ == "__main__":
    main()
