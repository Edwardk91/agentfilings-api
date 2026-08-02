"""Minimal SEC EDGAR client for the benchmark.

Deliberately standalone: this directory is meant to be extractable as its own
public repository, so it shares no code with the service it was written to
support. If the benchmark depended on AgentFilings internals, "AgentFilings
agrees with the benchmark" would be circular and worthless.

SEC requires a declared User-Agent with contact information and asks for no more
than 10 requests/second. We make a handful of requests, but the limiter is here
so a careless edit cannot turn this into a scraper.
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx

SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
COMPANYFACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"

_MIN_INTERVAL = 0.15  # ~6.7 req/s, comfortably inside SEC's ceiling


class SecClient:
    """Rate-limited SEC client. Requires SEC_CONTACT_EMAIL (SEC policy)."""

    def __init__(self, contact: str | None = None) -> None:
        contact = contact or os.environ.get("SEC_CONTACT_EMAIL")
        if not contact:
            raise SystemExit(
                "Set SEC_CONTACT_EMAIL to your email address.\n"
                "The SEC requires a contact in the User-Agent header and will "
                "block requests without one. See "
                "https://www.sec.gov/os/webmaster-faq#developers"
            )
        self._client = httpx.Client(
            headers={
                "User-Agent": f"agentfilings-benchmark/1.0 ({contact})",
                "Accept-Encoding": "gzip, deflate",
            },
            timeout=30.0,
        )
        self._last = 0.0

    def __enter__(self) -> "SecClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self._client.close()

    def _throttle(self) -> None:
        delta = time.monotonic() - self._last
        if delta < _MIN_INTERVAL:
            time.sleep(_MIN_INTERVAL - delta)
        self._last = time.monotonic()

    def get_json(self, url: str) -> Any:
        self._throttle()
        response = self._client.get(url)
        response.raise_for_status()
        return response.json()

    def submissions(self, cik: str) -> Any:
        return self.get_json(SUBMISSIONS_URL.format(cik=str(cik).zfill(10)))

    def companyfacts(self, cik: str) -> Any:
        return self.get_json(COMPANYFACTS_URL.format(cik=str(cik).zfill(10)))

    def ticker_map(self) -> dict[str, str]:
        """SEC's own ticker -> CIK mapping, as published."""
        raw = self.get_json(TICKERS_URL)
        out: dict[str, str] = {}
        for entry in raw.values():
            ticker = str(entry.get("ticker", "")).upper()
            if ticker:
                out[ticker] = str(entry["cik_str"]).zfill(10)
        return out


def facts_for(companyfacts: dict[str, Any], concept: str) -> list[dict[str, Any]]:
    """All USD-denominated fact entries for a us-gaap concept.

    SEC returns one entry per (period, filing) pair, so the same period appears
    repeatedly — once from its original filing and again from every later filing
    that restated or re-presented it. That redundancy is the whole subject of
    this benchmark, so it is preserved rather than collapsed here.
    """
    node = companyfacts.get("facts", {}).get("us-gaap", {}).get(concept)
    if not node:
        return []
    return list(node.get("units", {}).get("USD", []))
