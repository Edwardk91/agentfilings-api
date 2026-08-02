"""Parse a data.sec.gov submissions document.

`filings.recent` is COLUMN-ORIENTED: parallel arrays (accessionNumber[], form[],
filingDate[], primaryDocument[], reportDate[], ...) that must be zipped by index.
Older filings overflow into `filings.files` (separate JSON docs) — not loaded here;
"recent" (~1000 latest) covers Stage 0 /filings/latest.
"""

from __future__ import annotations

from typing import Any

from .models import CompanyProfile, Filing
from .tickers import cik_to_10

# Forms AgentFilings tracks (handoff §3).
TRACKED_FORMS = frozenset({"10-K", "10-Q", "8-K", "4", "13F-HR", "S-1"})


def parse_company(sub: dict[str, Any]) -> CompanyProfile:
    tickers = sub.get("tickers") or []
    return CompanyProfile(
        cik=cik_to_10(sub["cik"]),
        ticker=(tickers[0] if tickers else None),
        name=sub.get("name", ""),
        sic=sub.get("sic") or None,
        sic_description=sub.get("sicDescription") or None,
        exchanges=list(sub.get("exchanges") or []),
    )


def _archive_url(cik_int: int, accession: str, primary_doc: str) -> str:
    # Archives use the UNPADDED integer CIK and the accession with dashes removed.
    acc_nodash = accession.replace("-", "")
    return f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nodash}/{primary_doc}"


def parse_filings(
    sub: dict[str, Any],
    forms: frozenset[str] | set[str] | None = None,
    limit: int | None = None,
) -> list[Filing]:
    """Zip the column-oriented recent arrays into Filing rows (newest first, as SEC
    returns them). `forms` filters by form type; `limit` caps the count."""
    cik_int = int(sub["cik"])
    recent = sub["filings"]["recent"]
    accessions = recent["accessionNumber"]

    out: list[Filing] = []
    for i in range(len(accessions)):
        # Cap check first, so limit=0 (or negative) yields [] rather than one row.
        if limit is not None and len(out) >= limit:
            break
        form = recent["form"][i]
        if forms is not None and form not in forms:
            continue
        primary = recent["primaryDocument"][i] or None
        report_date = recent["reportDate"][i] or None
        url = _archive_url(cik_int, accessions[i], primary) if primary else None
        out.append(
            Filing(
                accession_no=accessions[i],
                form=form,
                filed_at=recent["filingDate"][i],
                period=report_date,
                primary_doc=primary,
                primary_doc_url=url,
            )
        )
    return out
