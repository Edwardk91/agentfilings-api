import time

from agentfilings_ingest.sec_client import RateLimiter
from agentfilings_ingest.tickers import cik_to_10


def test_cik_zero_pad():
    assert cik_to_10(320193) == "0000320193"
    assert cik_to_10("320193") == "0000320193"
    assert cik_to_10(1) == "0000000001"


def test_rate_limiter_spaces_calls():
    # 20 rps => 50ms min interval; 3 acquisitions span >= 2 intervals.
    rl = RateLimiter(max_per_second=20)
    start = time.monotonic()
    for _ in range(3):
        rl.acquire()
    elapsed = time.monotonic() - start
    assert elapsed >= 0.09


def test_rate_limiter_rejects_bad_rate():
    try:
        RateLimiter(0)
    except ValueError:
        return
    raise AssertionError("expected ValueError for non-positive rate")
