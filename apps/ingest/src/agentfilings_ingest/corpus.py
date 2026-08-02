"""Assemble a per-ticker corpus document from SEC submissions + companyfacts.

This is the interim store: `sync` writes one JSON file per ticker under data/corpus/,
which the API reads. When Supabase Postgres lands, the ingestion writes rows instead
and the API's repository swaps to a Postgres implementation; this JSON shape is the
contract in between (mirrors packages/shared types).
"""

from __future__ import annotations

from typing import Any

from .companyfacts import parse_earnings
from .submissions import parse_company, parse_filings

# The API serves at most 100 filings per call, so storing every "recent" row (~1000
# per company) bloats the database ~10x for data nobody can reach. Keep a healthy
# margin above the max page size.
MAX_FILINGS_PER_COMPANY = 250


def build_corpus(
    sub: dict[str, Any],
    facts: dict[str, Any],
    max_filings: int | None = MAX_FILINGS_PER_COMPANY,
) -> dict[str, Any]:
    company = parse_company(sub)
    filings = parse_filings(sub, limit=max_filings)  # newest first
    earnings = parse_earnings(facts)
    return {
        "company": company.to_dict(),
        "filings": [f.to_dict() for f in filings],
        "earnings": [e.to_dict() for e in earnings],
        "insiders": [],  # filled by sync (fetches + parses Form 4 docs)
        "meta": {"source": "sec-edgar"},  # retrieved_at stamped by the writer
    }
