"""The three checks.

Each one measures a property of SEC's own data and reports what a consumer
reading it naively would get wrong. None of them requires any particular library
to be installed: the ground truth is derived from `companyfacts` and
`company_tickers.json` directly, so the findings stand on primary sources.

Where a comparison library IS installed (see adapters.py), each check also
records what that library returns for the same question. That part is
best-effort by design -- if a library's API has moved, the check says so rather
than guessing, because a wrong claim about somebody else's project is worse than
no claim.
"""

from __future__ import annotations

from typing import Any

from lib import reference
from lib.sec import SecClient, facts_for

# Large, liquid, heavily-analysed companies across several filing styles. Chosen
# before any results were looked at, and kept fixed: picking the sample after
# seeing which names failed would make the whole exercise worthless.
SAMPLE = [
    ("AAPL", "0000320193"),
    ("MSFT", "0000789019"),
    ("XOM", "0000034088"),
    ("JPM", "0000019617"),
    ("WMT", "0000104169"),
    ("KO", "0000021344"),
]


def check_restatements(client: SecClient, adapter: Any | None = None) -> dict[str, Any]:
    """Do restated figures survive, or does the superseded number win?

    A period reported twice with different values has been restated. The
    company's current position is the later number. A reader that keeps the
    first entry it sees for a period returns a figure the company has since
    corrected -- silently, with no error and no warning.
    """
    companies: list[dict[str, Any]] = []
    for ticker, cik in SAMPLE:
        facts = client.companyfacts(cik)
        concept = reference.first_available_concept(facts, reference.REVENUE_CONCEPTS)
        if not concept:
            companies.append({"ticker": ticker, "cik": cik, "skipped": "no revenue concept"})
            continue

        entries = facts_for(facts, concept)
        restated = reference.restated_periods(entries)
        record: dict[str, Any] = {
            "ticker": ticker,
            "cik": cik,
            "concept": concept,
            "total_entries": len(entries),
            "distinct_periods": len(reference.group_by_period(entries)),
            "restated_periods": len(restated),
            "examples": restated[:3],
        }
        if adapter is not None and restated:
            record["library"] = adapter.revenue_for_periods(ticker, restated[:3])
        companies.append(record)

    total = sum(c.get("restated_periods", 0) for c in companies)
    return {
        "name": "restatement_survival",
        "question": "When a company restates a figure, which value does a consumer get?",
        "ground_truth": "The most recently filed value for a period is the company's current figure.",
        "companies": companies,
        "summary": {"restated_periods_found": total},
    }


def check_fiscal_labels(client: SecClient, adapter: Any | None = None) -> dict[str, Any]:
    """Do fiscal-year labels describe the period, or the filing that mentioned it?

    `fy`/`fp` on a companyfacts entry belong to the FILING. Prior-period
    comparatives inside a later filing therefore carry the later filing's fiscal
    year. Anything that filters or groups by fy without re-anchoring to the
    original filing mixes periods from different fiscal years together.
    """
    companies: list[dict[str, Any]] = []
    for ticker, cik in SAMPLE:
        facts = client.companyfacts(cik)
        concept = reference.first_available_concept(facts, reference.REVENUE_CONCEPTS)
        if not concept:
            companies.append({"ticker": ticker, "cik": cik, "skipped": "no revenue concept"})
            continue

        entries = facts_for(facts, concept)
        mislabelled = reference.mislabelled_periods(entries)
        total = len(entries)
        companies.append(
            {
                "ticker": ticker,
                "cik": cik,
                "concept": concept,
                "total_entries": total,
                "mislabelled_entries": len(mislabelled),
                "share_mislabelled": round(len(mislabelled) / total, 3) if total else 0.0,
                "examples": mislabelled[:3],
            }
        )

    entries_total = sum(c.get("total_entries", 0) for c in companies)
    mislabelled_total = sum(c.get("mislabelled_entries", 0) for c in companies)
    return {
        "name": "fiscal_label_provenance",
        "question": "Does a period's fiscal year come from its own filing, or a later one?",
        "ground_truth": "A period's fiscal labels come from the filing that FIRST reported it.",
        "companies": companies,
        "summary": {
            "entries_examined": entries_total,
            "entries_carrying_a_later_filings_fiscal_year": mislabelled_total,
            "share": round(mislabelled_total / entries_total, 3) if entries_total else 0.0,
        },
    }


def check_entity_identity(client: SecClient, adapter: Any | None = None) -> dict[str, Any]:
    """Does a ticker resolve to the operating company, or to an empty shell?

    SEC's published ticker map can point at a post-reorganization entity that
    holds the ticker but files no us-gaap financial data. Resolving through it
    yields a company that looks legitimate -- correct name, valid CIK -- and
    returns nothing, with no error to distinguish "no data" from "wrong entity".
    """
    ticker_map = client.ticker_map()
    rows: list[dict[str, Any]] = []
    for ticker, expected_cik in SAMPLE:
        mapped = ticker_map.get(ticker)
        row: dict[str, Any] = {
            "ticker": ticker,
            "sec_ticker_map_cik": mapped,
            "operating_cik": expected_cik,
            "agrees": mapped == expected_cik,
        }
        if mapped and mapped != expected_cik:
            # Only fetch when they disagree -- that is the case worth explaining,
            # and it keeps the request count down.
            mapped_facts = client.companyfacts(mapped)
            expected_facts = client.companyfacts(expected_cik)
            row["mapped_entity_name"] = mapped_facts.get("entityName")
            row["mapped_has_us_gaap_facts"] = reference.has_operating_facts(mapped_facts)
            row["operating_entity_name"] = expected_facts.get("entityName")
            row["operating_has_us_gaap_facts"] = reference.has_operating_facts(expected_facts)
        if adapter is not None:
            row["library"] = adapter.resolve_ticker(ticker)
        rows.append(row)

    disagreements = [r for r in rows if not r["agrees"]]
    empty_shells = [r for r in disagreements if r.get("mapped_has_us_gaap_facts") is False]
    return {
        "name": "entity_identity",
        "question": "Does ticker -> CIK resolution land on the entity that actually files?",
        "ground_truth": "The correct CIK is the one reporting us-gaap facts for the operating business.",
        "companies": rows,
        "summary": {
            "tickers_checked": len(rows),
            "ticker_map_disagreements": len(disagreements),
            "resolving_to_entity_with_no_us_gaap_facts": len(empty_shells),
        },
    }


ALL_CHECKS = (check_restatements, check_fiscal_labels, check_entity_identity)
