"""HTTP client for SEC EDGAR with the hard-requirement guardrails (handoff §3):

- Global rate limiter capped at 10 requests/second (violating gets the IP blocked).
- A declared User-Agent carrying a contact email (SEC fair-access policy).

The rate limiter is a process-global min-interval gate so concurrent workers in
the same process cannot collectively exceed the cap. Cross-process/host
concurrency must be bounded separately (single ingestion worker at launch).
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

SEC_MAX_RPS = 10
_USER_AGENT_TEMPLATE = "AgentFilings/1.0 (contact: {email})"

# Transient-failure retry. Kept small: the rate limiter already paces requests, and
# SEC blocks aggressive clients.
MAX_RETRIES = 3
RETRY_BACKOFF_SEC = 1.0


class RateLimiter:
    """Thread-safe minimum-interval limiter shared across callers."""

    def __init__(self, max_per_second: int) -> None:
        if max_per_second <= 0:
            raise ValueError("max_per_second must be positive")
        self._min_interval = 1.0 / max_per_second
        self._lock = threading.Lock()
        self._next_allowed = 0.0

    def acquire(self) -> None:
        """Block until the next request slot is available, then reserve it."""
        with self._lock:
            now = time.monotonic()
            wait = self._next_allowed - now
            if wait > 0:
                time.sleep(wait)
                now = time.monotonic()
            self._next_allowed = max(now, self._next_allowed) + self._min_interval


# Module-global limiter: every SecClient in this process shares one 10 rps budget.
_limiter = RateLimiter(SEC_MAX_RPS)


def _user_agent() -> str:
    email = os.environ.get("SEC_CONTACT_EMAIL")
    if not email:
        raise RuntimeError(
            "SEC_CONTACT_EMAIL is required: the SEC fair-access policy mandates a "
            "contact address in the User-Agent on every request."
        )
    return _USER_AGENT_TEMPLATE.format(email=email)


@dataclass
class SecClient:
    """Thin wrapper over httpx.Client that enforces the SEC guardrails."""

    timeout: float = 30.0
    _client: httpx.Client = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._client = httpx.Client(
            headers={
                "User-Agent": _user_agent(),
                "Accept-Encoding": "gzip, deflate",
            },
            timeout=self.timeout,
        )

    def _get(self, url: str) -> httpx.Response:
        """GET with retry on transient failures.

        SEC intermittently returns 429/5xx or drops a connection; a single blip should
        not fail a whole ticker during a 500-company backfill. 403 is NOT retried —
        that means we are being blocked and hammering would make it worse.
        """
        last_exc: Exception | None = None
        for attempt in range(MAX_RETRIES):
            _limiter.acquire()
            try:
                resp = self._client.get(url)
                if resp.status_code == 429 or resp.status_code >= 500:
                    last_exc = httpx.HTTPStatusError(
                        f"transient {resp.status_code}", request=resp.request, response=resp
                    )
                else:
                    resp.raise_for_status()
                    return resp
            except (httpx.TransportError, httpx.HTTPStatusError) as exc:
                if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 403:
                    raise  # blocked: do not retry
                last_exc = exc

            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF_SEC * (2**attempt))

        assert last_exc is not None
        raise last_exc

    def get_json(self, url: str) -> dict[str, Any]:
        return self._get(url).json()

    def get_bytes(self, url: str) -> bytes:
        return self._get(url).content

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> SecClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
