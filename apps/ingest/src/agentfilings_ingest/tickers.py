"""Company ticker -> CIK mapping from SEC's public file (handoff §3).

Source: https://www.sec.gov/files/company_tickers.json
Shape (as documented): a JSON object keyed by row index, each row
{"cik_str": <int>, "ticker": "AAPL", "title": "Apple Inc."}.
CIK is zero-padded to 10 digits for the data.sec.gov submissions/companyfacts APIs.

NOTE: SEC's ticker map is ambiguous for companies that have reorganized - it can
return a shell entity that holds the ticker but files no XBRL. Callers should
prefer an authoritative CIK where one is available; see universe.py.
"""

from __future__ import annotations

from dataclasses import dataclass

from .sec_client import SecClient

COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"


def cik_to_10(cik: int | str) -> str:
    """Zero-pad a CIK to the 10-digit form used by data.sec.gov APIs."""
    return str(int(cik)).zfill(10)


@dataclass(frozen=True)
class Company:
    cik: str  # 10-digit
    ticker: str
    name: str


def load_ticker_map(client: SecClient) -> dict[str, Company]:
    """Return {TICKER: Company} with 10-digit CIKs."""
    raw = client.get_json(COMPANY_TICKERS_URL)
    out: dict[str, Company] = {}
    for row in raw.values():
        ticker = str(row["ticker"]).upper()
        out[ticker] = Company(
            cik=cik_to_10(row["cik_str"]),
            ticker=ticker,
            name=str(row["title"]),
        )
    return out
