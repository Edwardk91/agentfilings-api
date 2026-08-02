# ingest — EDGAR sync + parsers (Python 3.12)

Pulls SEC EDGAR public data into the AgentFilings corpus. See handoff §3.

## Guardrails (hard requirements)

- **≤ 10 requests/second**, enforced by a process-global `RateLimiter` in
  `sec_client.py`. Exceeding the cap gets the IP blocked.
- **User-Agent** `AgentFilings/1.0 (contact: <SEC_CONTACT_EMAIL>)` on every
  request. `SEC_CONTACT_EMAIL` must be set or the client refuses to start.
- Prefer the nightly **bulk zips** for backfill; incremental API polling for
  daily sync.

## Dev

```bash
cd apps/ingest
python -m venv .venv && . .venv/Scripts/activate   # Windows: .venv\Scripts\Activate.ps1
pip install -e ".[dev]"
ruff check .
pytest -q
```

## Status

Rate-limited SEC client, ticker→CIK resolution, and the submissions /
companyfacts / Form 4 parsers.
