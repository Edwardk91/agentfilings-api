"""Rate-limit handling in the scheduled refresh.

This is failure-path code: it only executes while SEC is actively throttling us, so it
would otherwise go unexercised until the night it matters. On 2026-09-01 it did matter —
a run logged 101 consecutive `transient 429` failures because each ticker exhausted its
retries inside SEC's block and the loop kept going, firing several hundred more requests
at an address that was already refusing them.
"""

import httpx

from agentfilings_ingest import sync as sync_mod
from agentfilings_ingest.sec_client import is_rate_limited
from agentfilings_ingest.sync import sync_tickers


def _status_error(code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "https://data.sec.gov/submissions/CIK0000000001.json")
    response = httpx.Response(code, request=request)
    return httpx.HTTPStatusError(f"transient {code}", request=request, response=response)


def test_is_rate_limited_only_matches_429():
    assert is_rate_limited(_status_error(429))
    # A 5xx is a momentary blip and keeps the short backoff; only 429 means "blocked".
    assert not is_rate_limited(_status_error(503))
    assert not is_rate_limited(ValueError("not an HTTP error at all"))


class _Client:
    """Stands in for SecClient, raising a caller-supplied sequence of errors."""

    def __init__(self, codes: list[int]) -> None:
        self._codes = codes
        self.calls = 0

    def __call__(self) -> "_Client":  # SecClient() in sync_tickers
        return self

    def __enter__(self) -> "_Client":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def get_json(self, url: str) -> dict:
        code = self._codes[self.calls % len(self._codes)]
        self.calls += 1
        raise _status_error(code)


def _tickers(n: int) -> tuple[list[str], dict[str, str]]:
    names = [f"T{i}" for i in range(n)]
    # Supplying CIKs skips load_ticker_map, so the fake client sees only ticker fetches.
    return names, {t: "0000000001" for t in names}


def test_aborts_after_consecutive_rate_limits(monkeypatch):
    client = _Client([429])
    monkeypatch.setattr(sync_mod, "SecClient", client)
    names, cik_map = _tickers(25)

    result = sync_tickers(names, cik_map=cik_map)

    assert result.throttled is True
    assert result.ok == 0
    # Stops at the threshold rather than burning the whole batch against a closed door.
    assert result.failed == sync_mod.RATE_LIMIT_ABORT_STREAK
    assert client.calls == sync_mod.RATE_LIMIT_ABORT_STREAK


def test_other_transient_errors_do_not_trip_the_breaker(monkeypatch):
    # Alternating 429/503 never reaches a *consecutive* streak, so the pass runs on.
    # Mixed transient noise is normal; only a sustained block should abort.
    monkeypatch.setattr(sync_mod, "SecClient", _Client([429, 503]))
    names, cik_map = _tickers(12)

    result = sync_tickers(names, cik_map=cik_map)

    assert result.throttled is False
    assert result.failed == 12


class _Form4Client:
    """Submissions/facts succeed; the Form 4 documents come back throttled."""

    def __init__(self, sub: dict, facts: dict) -> None:
        self._sub, self._facts = sub, facts

    def __call__(self) -> "_Form4Client":
        return self

    def __enter__(self) -> "_Form4Client":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def get_json(self, url: str) -> dict:
        return self._facts if "companyfacts" in url else self._sub

    def get_bytes(self, url: str) -> bytes:
        raise _status_error(429)


def test_throttled_form4_fails_the_ticker_instead_of_emptying_it(monkeypatch):
    """A 429 mid-Form-4 must not produce a short list that replaces stored rows."""
    sub = {
        "cik": "1",
        "filings": {
            "recent": {
                "accessionNumber": ["0000000001-26-000001"],
                "form": ["4"],
                "primaryDocument": ["doc.xml"],
                "filingDate": ["2026-09-01"],
            }
        },
    }
    facts = {"facts": {"us-gaap": {"Revenues": {}}}}
    monkeypatch.setattr(sync_mod, "SecClient", _Form4Client(sub, facts))
    empty = {"filings": [], "earnings": [], "meta": {}}
    monkeypatch.setattr(sync_mod, "build_corpus", lambda s, f: dict(empty))
    names, cik_map = _tickers(1)

    result = sync_tickers(names, cik_map=cik_map)

    # The ticker fails rather than "succeeding" with its insider rows wiped.
    assert result.ok == 0
    assert result.failed == 1
