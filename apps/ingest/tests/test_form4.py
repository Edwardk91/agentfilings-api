from pathlib import Path

from agentfilings_ingest.form4 import parse_form4, raw_doc_name

FIX = Path(__file__).parent / "fixtures"


def test_raw_doc_name_strips_xsl_prefix():
    assert raw_doc_name("xslF345X06/form4.xml") == "form4.xml"
    assert raw_doc_name("wk-form4_123.xml") == "wk-form4_123.xml"


def test_parse_form4():
    f4 = parse_form4((FIX / "aapl_form4.xml").read_bytes())

    assert f4.issuer_ticker == "AAPL"
    assert f4.issuer_name == "Apple Inc."
    assert f4.issuer_cik == "0000320193"
    assert f4.owner_name == "Newstead Jennifer"
    assert f4.relationship == ["officer"]
    assert f4.officer_title == "SVP, GC and Secretary"

    assert f4.transactions
    t = f4.transactions[0]
    assert t.code == "M"
    assert t.shares == 30104.0
    assert t.price is None  # price disclosed only in a footnote
    assert t.acquired_disposed == "A"
    assert t.shares_owned_after == 57784.0
    assert t.derivative is False


def test_transaction_date_strips_timezone_offset():
    # Real SEC data: some filer software emits '2026-05-12-05:00' (date + tz offset).
    # Postgres rejects that as a date, which previously failed a whole company's sync.
    xml = b"""<ownershipDocument>
      <periodOfReport>2026-05-12-05:00</periodOfReport>
      <nonDerivativeTable><nonDerivativeTransaction>
        <transactionDate><value>2026-05-12-05:00</value></transactionDate>
        <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      </nonDerivativeTransaction></nonDerivativeTable>
    </ownershipDocument>"""
    f4 = parse_form4(xml)
    assert f4.period_of_report == "2026-05-12"
    assert f4.transactions[0].transaction_date == "2026-05-12"


def test_unparseable_date_becomes_none():
    xml = (
        b"<ownershipDocument><nonDerivativeTable><nonDerivativeTransaction>"
        b"<transactionDate><value>not-a-date</value></transactionDate>"
        b"</nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>"
    )
    assert parse_form4(xml).transactions[0].transaction_date is None


def test_parse_form4_handles_missing_elements():
    # A minimal document with no tables / relationship must not raise.
    minimal = b"<ownershipDocument><documentType>4</documentType></ownershipDocument>"
    f4 = parse_form4(minimal)
    assert f4.transactions == []
    assert f4.relationship == []
    assert f4.owner_name is None
