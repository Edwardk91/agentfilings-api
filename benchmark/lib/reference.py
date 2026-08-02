"""The correct reading of SEC XBRL company facts, derived from primary data only.

Everything here follows from one fact about the `companyfacts` API that is easy
to miss and expensive to get wrong:

    A fact entry describes a PERIOD, but its `fy` and `fp` fields describe the
    FILING the entry came from -- not the period it measures.

A 10-Q filed in FY2026 that shows last year's quarter as a comparative produces
an entry for that older period carrying fy=2026. Read naively, the older quarter
is relabelled with the newer filing's fiscal year.

Two independent consequences, and they pull in opposite directions:

  * For the VALUE of a period, the newest filing wins. Restatements exist, and
    the most recently filed number is the company's current position.
  * For the LABEL of a period, the oldest filing wins. The original filing is
    the one whose fiscal calendar actually describes that period.

Taking the first entry, the last entry, or de-duplicating by period alone gets
one of these wrong. That is what the checks in this repository measure.
"""

from __future__ import annotations

from typing import Any, Iterable

# A period is identified by its bounds. Instant facts (balance-sheet items) have
# no start; the checks here use duration facts only.
Period = tuple[str, str]


def period_of(entry: dict[str, Any]) -> Period | None:
    start, end = entry.get("start"), entry.get("end")
    if not start or not end:
        return None
    return (start, end)


def group_by_period(entries: Iterable[dict[str, Any]]) -> dict[Period, list[dict[str, Any]]]:
    """Bucket fact entries by the period they measure, preserving every filing."""
    grouped: dict[Period, list[dict[str, Any]]] = {}
    for entry in entries:
        period = period_of(entry)
        if period is None:
            continue
        grouped.setdefault(period, []).append(entry)
    return grouped


def _filed(entry: dict[str, Any]) -> str:
    # ISO dates sort lexicographically, so a string sort is a date sort here.
    return str(entry.get("filed") or "")


def current_value(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """The company's CURRENT figure for a period: the most recently filed entry.

    Where a value was restated, this is the restated one. Ties on filing date are
    broken by accession number so the result is deterministic.
    """
    return max(entries, key=lambda e: (_filed(e), str(e.get("accn") or "")))


def original_filing(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """The entry from the filing that FIRST reported this period.

    Its `fy`/`fp` are the only fiscal labels in the dataset that actually
    describe this period rather than some later filing that re-presented it.
    """
    return min(entries, key=lambda e: (_filed(e), str(e.get("accn") or "")))


def restated_periods(entries: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Periods whose reported value changed between filings.

    Returns one record per genuinely restated period, carrying both the value a
    first-entry-wins reader would surface and the company's current figure.
    """
    out: list[dict[str, Any]] = []
    for period, group in group_by_period(entries).items():
        values = {e.get("val") for e in group}
        if len(values) < 2:
            continue
        first, last = original_filing(group), current_value(group)
        if first.get("val") == last.get("val"):
            continue
        out.append(
            {
                "period_start": period[0],
                "period_end": period[1],
                "original_value": first.get("val"),
                "original_accession": first.get("accn"),
                "original_filed": first.get("filed"),
                "current_value": last.get("val"),
                "current_accession": last.get("accn"),
                "current_filed": last.get("filed"),
                "filings_reporting_period": len(group),
            }
        )
    out.sort(key=lambda r: r["period_end"], reverse=True)
    return out


def mislabelled_periods(entries: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fact entries whose fy/fp disagree with the period's original filing.

    Counted per ENTRY, not per period: an entry is the unit a consumer actually
    reads, and one period can be mislabelled by several later filings.
    """
    out: list[dict[str, Any]] = []
    for period, group in group_by_period(entries).items():
        origin = original_filing(group)
        true_fy, true_fp = origin.get("fy"), origin.get("fp")
        for entry in group:
            if entry.get("fy") == true_fy and entry.get("fp") == true_fp:
                continue
            out.append(
                {
                    "period_start": period[0],
                    "period_end": period[1],
                    "entry_fy": entry.get("fy"),
                    "entry_fp": entry.get("fp"),
                    "entry_accession": entry.get("accn"),
                    "entry_filed": entry.get("filed"),
                    "true_fy": true_fy,
                    "true_fp": true_fp,
                    "true_accession": origin.get("accn"),
                }
            )
    out.sort(key=lambda r: (r["period_end"], str(r["entry_accession"])), reverse=True)
    return out


def has_operating_facts(companyfacts: dict[str, Any]) -> bool:
    """Whether an entity actually reports us-gaap financial data.

    An entity with a CIK, a ticker, and no us-gaap facts is typically a
    post-reorganization shell that inherited the ticker. Resolving a ticker to
    one of these yields a company that looks real and returns nothing.
    """
    return bool(companyfacts.get("facts", {}).get("us-gaap"))


# Revenue has been reported under several tags over time. A reader that checks
# only one will silently return nothing for companies using another, so the
# checks try them in order of specificity.
REVENUE_CONCEPTS = (
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
)


def first_available_concept(companyfacts: dict[str, Any], concepts: Iterable[str]) -> str | None:
    node = companyfacts.get("facts", {}).get("us-gaap", {})
    for concept in concepts:
        if concept in node:
            return concept
    return None
