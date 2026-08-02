"""Parse a data.sec.gov XBRL companyfacts document into earnings periods.

Facts live at facts[taxonomy][concept]["units"][unit] as a list of entries:
  {start?, end, val, accn, fy, fp, form, filed, frame?}

Gotchas, each verified against live SEC responses:
- Instantaneous facts (shares outstanding, balance-sheet) OMIT `start` — skip them
  here (earnings items are durational) and always use `.get(...)`.
- The same (start,end) period is re-reported across filings (restatements) — dedupe
  keeping the latest `filed` for the numeric VALUE.
- `fy`/`fp` describe the FILING, not the covered period. A 10-Q/10-K embeds prior-
  year comparatives that carry the *filing's* fy/fp, so the latest re-report of a
  period is labeled with a later fiscal year. Therefore the period's fiscal identity
  (fiscal_year/fiscal_period/frame) is taken from the ORIGINAL (earliest-filed)
  entry — the one where the period was the current period — NOT the latest.
- Revenue tag changed over time — try RevenueFromContractWithCustomerExcludingAssessedTax,
  then Revenues, then SalesRevenueNet.
- `fp` is unreliable for period LENGTH (a 10-K tags Q4 revenue as fp="FY"), so classify
  annual vs quarterly by the start→end DURATION, not `fp`.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from .models import EarningsPeriod

# Concept fallback chains, highest priority first.
REVENUE_CONCEPTS = (
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
)
NET_INCOME_CONCEPTS = ("NetIncomeLoss",)
EPS_BASIC_CONCEPTS = ("EarningsPerShareBasic",)
EPS_DILUTED_CONCEPTS = ("EarningsPerShareDiluted",)

# (concepts, unit) groups whose entries can supply a period's fiscal identity.
LABEL_SOURCES = (
    (REVENUE_CONCEPTS, "USD"),
    (NET_INCOME_CONCEPTS, "USD"),
    (EPS_BASIC_CONCEPTS, "USD/shares"),
    (EPS_DILUTED_CONCEPTS, "USD/shares"),
)

PeriodKey = tuple[str, str]  # (start, end)


def _days(start: str, end: str) -> int:
    y1, m1, d1 = (int(x) for x in start.split("-"))
    y2, m2, d2 = (int(x) for x in end.split("-"))
    return (date(y2, m2, d2) - date(y1, m1, d1)).days


def _classify(start: str, end: str) -> str:
    d = _days(start, end)
    if d >= 350:
        return "annual"
    if d <= 100:
        return "quarterly"
    return "interim"  # 6-month / 9-month year-to-date figures from 10-Qs


def _series(
    gaap: dict[str, Any], concepts: tuple[str, ...], unit: str
) -> dict[PeriodKey, dict[str, Any]]:
    """One VALUE entry per (start,end): higher-priority concept wins; within a
    concept the latest `filed` wins (restatement → most current figure). Entries
    without `start` are skipped."""
    chosen: dict[PeriodKey, tuple[int, dict[str, Any]]] = {}
    for rank, concept in enumerate(concepts):
        node = gaap.get(concept)
        if not node:
            continue
        for e in node.get("units", {}).get(unit, []):
            start = e.get("start")
            end = e.get("end")
            if start is None or end is None:
                continue
            key = (start, end)
            cur = chosen.get(key)
            if cur is None:
                chosen[key] = (rank, e)
                continue
            cur_rank, cur_e = cur
            if rank < cur_rank:
                chosen[key] = (rank, e)
            elif rank == cur_rank and (e.get("filed") or "") > (cur_e.get("filed") or ""):
                chosen[key] = (rank, e)
    return {k: v[1] for k, v in chosen.items()}


def _origin_labels(gaap: dict[str, Any]) -> dict[PeriodKey, dict[str, Any]]:
    """Earliest-filed entry per (start,end) across all earnings metrics. This is
    the ORIGINAL filing, where the period was the current period, so its fy/fp/frame
    are the period's true fiscal identity (unlike later comparative re-reports)."""
    origin: dict[PeriodKey, dict[str, Any]] = {}
    for concepts, unit in LABEL_SOURCES:
        for concept in concepts:
            node = gaap.get(concept)
            if not node:
                continue
            for e in node.get("units", {}).get(unit, []):
                start = e.get("start")
                end = e.get("end")
                if start is None or end is None:
                    continue
                key = (start, end)
                cur = origin.get(key)
                if cur is None or (e.get("filed") or "") < (cur.get("filed") or ""):
                    origin[key] = e
    return origin


def _val(series: dict[PeriodKey, dict[str, Any]], key: PeriodKey) -> float | None:
    entry = series.get(key)
    return entry.get("val") if entry else None


def parse_earnings(facts: dict[str, Any]) -> list[EarningsPeriod]:
    """Return earnings periods (newest period_end first) joining revenue, net income,
    and EPS on their shared (start,end) period.

    Values are the latest restated figure; fiscal_year/fiscal_period/frame and the
    source filing are the ORIGINAL report (see module docstring)."""
    gaap = facts.get("facts", {}).get("us-gaap", {})

    revenue = _series(gaap, REVENUE_CONCEPTS, "USD")
    net_income = _series(gaap, NET_INCOME_CONCEPTS, "USD")
    eps_basic = _series(gaap, EPS_BASIC_CONCEPTS, "USD/shares")
    eps_diluted = _series(gaap, EPS_DILUTED_CONCEPTS, "USD/shares")
    origin = _origin_labels(gaap)

    keys: set[PeriodKey] = set(revenue) | set(net_income) | set(eps_basic) | set(eps_diluted)

    periods: list[EarningsPeriod] = []
    for key in keys:
        start, end = key
        label = origin[key]  # every value key has an origin entry (same source rows)
        periods.append(
            EarningsPeriod(
                period_start=start,
                period_end=end,
                duration=_classify(start, end),
                fiscal_year=label.get("fy"),
                fiscal_period=label.get("fp"),
                frame=label.get("frame"),
                revenue=_val(revenue, key),
                net_income=_val(net_income, key),
                eps_basic=_val(eps_basic, key),
                eps_diluted=_val(eps_diluted, key),
                form=label.get("form"),
                filed_at=label.get("filed"),
                source_accession=label.get("accn"),
            )
        )

    periods.sort(key=lambda p: (p.period_end, p.period_start), reverse=True)
    return periods
