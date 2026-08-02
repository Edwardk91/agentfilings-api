# infra

Deploy configs and cron definitions. Targets below reflect the deployed stack.

- **API service:** **Railway Hobby ($5/mo)** — always-on by default, no cold
  start (cold start would break x402 payment timing). Chosen over Fly.io, which
  dropped its hobby tier (Oct 2024) and needs `min_machines_running=1` +
  `auto_stop_machines` disabled to guarantee always-on. Set a Railway hard usage
  cap; the in-process SEC-JSON assembly is memory-sensitive.
- **Ingestion cron:** GitHub Actions scheduled workflows ($0) in a **private**
  repo, **idempotent/cursor-based**, off-peak minutes (e.g. `7,37 * * * *`), with
  a heartbeat monitor. GH schedules drift 5–30+ min and silently skip; public-repo
  schedules auto-disable after 60 days. Fallback to Railway cron if exact cadence
  becomes load-bearing.
- **DB:** Supabase Postgres via the **Supavisor transaction pooler (port 6543)**.
  Free for prototype (pauses after ~1 week idle, 500 MB); **Pro $25/mo before real
  traffic**.
- **Cache:** Upstash Redis, pay-as-you-go (~$0.20 / 100K commands).

**Budget:** prototype ~$5/mo; production-safe ~$31–35/mo (Railway $5 + Supabase
Pro $25 + Upstash ~$1–5 + Actions $0 + CDP facilitator $0 under 1,000 settles/mo,
then $0.001/settle).

Deploy config files land here once the Railway project exists.
