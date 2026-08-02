from agentfilings_ingest.universe import load_universe, normalize_ticker


def test_normalize_ticker():
    assert normalize_ticker("brk.b") == "BRK-B"
    assert normalize_ticker(" aapl ") == "AAPL"


def test_universe_loads_with_ciks():
    entries = load_universe("sp500")
    assert len(entries) > 450
    by_ticker = {e.ticker: e.cik for e in entries}

    # CIKs are 10-digit zero-padded, matching the data.sec.gov URL form.
    assert all(len(e.cik) == 10 and e.cik.isdigit() for e in entries)
    assert by_ticker["AAPL"] == "0000320193"

    # Dotted index symbols are normalized to SEC's dashed form.
    assert "BRK-B" in by_ticker

    # Regression: XOM must resolve to Exxon Mobil Corporation (CIK 34088), NOT the
    # post-reorganization shell "ExxonMobil Holdings Corp" (CIK 2115436) that SEC's
    # ticker->CIK map returns and which carries zero XBRL facts.
    assert by_ticker["XOM"] == "0000034088"
