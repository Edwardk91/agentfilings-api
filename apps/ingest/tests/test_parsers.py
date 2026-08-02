import json
from pathlib import Path

from agentfilings_ingest.companyfacts import _classify, parse_earnings
from agentfilings_ingest.submissions import parse_company, parse_filings

FIX = Path(__file__).parent / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def _e(start, end, val, filed, accn, fy=2025, fp="Q1", form="10-Q"):
    """Build a companyfacts entry; pass start=None to model an instantaneous fact."""
    d = {"end": end, "val": val, "filed": filed, "accn": accn, "fy": fy, "fp": fp, "form": form}
    if start is not None:
        d["start"] = start
    return d


def _facts(concept_units):
    """concept_units: {concept: {unit: [entries]}} -> a companyfacts-shaped dict."""
    return {"facts": {"us-gaap": {c: {"units": u} for c, u in concept_units.items()}}}


# --- submissions ------------------------------------------------------------

def test_parse_company():
    c = parse_company(_load("aapl_submissions.json"))
    assert c.cik == "0000320193"
    assert c.ticker == "AAPL"
    assert "Apple" in c.name


def test_parse_filings_all_and_url():
    sub = _load("aapl_submissions.json")
    filings = parse_filings(sub)
    assert len(filings) == 16
    withdoc = [f for f in filings if f.primary_doc_url]
    assert withdoc, "expected at least one filing with a primary doc"
    f = withdoc[0]
    acc_nodash = f.accession_no.replace("-", "")
    assert f.primary_doc_url == (
        f"https://www.sec.gov/Archives/edgar/data/320193/{acc_nodash}/{f.primary_doc}"
    )


def test_parse_filings_form_filter_and_limit():
    sub = _load("aapl_submissions.json")
    tenq = parse_filings(sub, forms={"10-Q"})
    assert len(tenq) >= 1
    assert all(f.form == "10-Q" for f in tenq)
    assert len(parse_filings(sub, limit=3)) == 3


def test_parse_filings_limit_zero_or_negative_returns_empty():
    sub = _load("aapl_submissions.json")
    assert parse_filings(sub, limit=0) == []
    assert parse_filings(sub, limit=-3) == []


# --- companyfacts / earnings ------------------------------------------------

def test_parse_earnings_from_fixture():
    periods = parse_earnings(_load("aapl_companyfacts.json"))
    assert periods, "expected earnings periods"

    # Newest period first; AAPL FY2026 Q2 ended 2026-03-28.
    top = periods[0]
    assert top.period_end == "2026-03-28"
    assert top.duration == "quarterly"
    assert top.revenue == 111184000000
    assert top.net_income == 29578000000
    assert top.eps_basic == 2.02
    assert top.eps_diluted == 2.01
    assert top.source_accession == "0000320193-26-000013"

    # Sorted descending by period_end.
    ends = [p.period_end for p in periods]
    assert ends == sorted(ends, reverse=True)

    # No duplicate (start, end) periods.
    keys = [(p.period_start, p.period_end) for p in periods]
    assert len(keys) == len(set(keys))

    # Both annual and quarterly durations represented.
    durations = {p.duration for p in periods}
    assert "annual" in durations
    assert "quarterly" in durations

    # Regression: the quarter ending 2025-03-29 is Apple FY2025 Q2, even though a
    # later 10-Q re-reports it as a prior-year comparative stamped fy=2026.
    q = next(p for p in periods if p.period_end == "2025-03-29" and p.duration == "quarterly")
    assert q.fiscal_year == 2025
    assert q.fiscal_period == "Q2"


def test_classify_by_duration_not_fp():
    assert _classify("2025-01-01", "2025-12-31") == "annual"
    assert _classify("2025-01-01", "2025-03-31") == "quarterly"
    assert _classify("2025-01-01", "2025-06-30") == "interim"


def test_value_from_latest_but_labels_from_original():
    # Same period reported twice: the original 10-Q (fy2025 Q2, filed 2025-05) and a
    # prior-year comparative embedded in a later 10-Q (fy2026, filed 2026-05, with a
    # restated value). Value tracks the latest filing; fiscal identity + provenance
    # track the ORIGINAL (else fiscal-year filtering breaks — parser review finding).
    facts = _facts({
        "NetIncomeLoss": {"USD": [
            _e("2025-01-01", "2025-03-31", 100, "2025-05-01", "orig", fy=2025, fp="Q2"),
            _e("2025-01-01", "2025-03-31", 110, "2026-05-01", "comparative", fy=2026, fp="Q2"),
        ]},
    })
    periods = parse_earnings(facts)
    assert len(periods) == 1
    p = periods[0]
    assert p.net_income == 110  # latest restated value
    assert p.fiscal_year == 2025  # original filing's fiscal identity, not the comparative's 2026
    assert p.fiscal_period == "Q2"
    assert p.source_accession == "orig"


def test_revenue_concept_priority():
    facts = _facts({
        "Revenues": {"USD": [
            _e("2020-01-01", "2020-12-31", 500, "2021-02-01", "r", fy=2020, fp="FY", form="10-K"),
        ]},
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"USD": [
            _e("2020-01-01", "2020-12-31", 600, "2021-02-01", "rc", fy=2020, fp="FY", form="10-K"),
        ]},
    })
    periods = parse_earnings(facts)
    assert len(periods) == 1
    # Primary concept wins over the Revenues fallback for the same period.
    assert periods[0].revenue == 600


def test_instantaneous_fact_without_start_is_skipped():
    facts = _facts({
        "NetIncomeLoss": {"USD": [
            _e(None, "2025-03-31", 100, "2025-04-30", "a"),  # instantaneous, no start
            _e("2025-01-01", "2025-03-31", 100, "2025-04-30", "a"),
        ]},
    })
    periods = parse_earnings(facts)
    assert len(periods) == 1
