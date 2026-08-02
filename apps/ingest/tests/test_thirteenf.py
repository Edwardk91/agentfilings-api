from pathlib import Path

from agentfilings_ingest.thirteenf import parse_13f_information_table

FIX = Path(__file__).parent / "fixtures"


def test_parse_13f_information_table():
    holdings = parse_13f_information_table((FIX / "berkshire_13f.xml").read_bytes())

    assert len(holdings) == 90
    h = holdings[0]
    assert h.issuer == "ALLY FINL INC"
    assert h.title_of_class == "COM"
    assert h.cusip == "02005N100"
    assert h.value == 498992850
    assert h.shares == 12719675
    assert h.shares_type == "SH"

    # Every holding has a CUSIP (the join key for a future ticker reverse-index).
    assert all(x.cusip for x in holdings)


def test_parse_13f_handles_namespace_and_missing():
    xml = (
        b'<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/'
        b'informationtable"><infoTable><nameOfIssuer>ACME</nameOfIssuer>'
        b"<cusip>123456789</cusip></infoTable></informationTable>"
    )
    holdings = parse_13f_information_table(xml)
    assert len(holdings) == 1
    assert holdings[0].issuer == "ACME"
    assert holdings[0].cusip == "123456789"
    assert holdings[0].value is None
    assert holdings[0].shares is None


def test_parse_13f_empty():
    xml = b'<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable"/>'
    assert parse_13f_information_table(xml) == []
