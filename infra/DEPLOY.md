# Deploying the API to Railway

The service is a long-running Node process (not serverless) — required for x402
middleware compatibility and to avoid cold starts during payment settlement.

## One-time setup

1. **New project** → *Deploy from GitHub repo* → pick `Edwardk91/agentfilings`.
   Railway reads [`railway.json`](../railway.json): Nixpacks build, `pnpm start`,
   health check on `/health`.
2. **Set the variables below** (Railway → service → *Variables*).
3. **Generate a public domain** (Railway → service → *Settings* → *Networking* →
   *Generate Domain*). That URL is the service's public address.

Railway auto-deploys on every push to `main` once connected.

## Environment variables

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | **yes** | Supabase **transaction pooler** URI, port **6543**. The direct `db.*.supabase.co:5432` host is IPv6-only and will not resolve. |
| `SEC_CONTACT_EMAIL` | yes | Contact address embedded in the SEC User-Agent. |
| `X402_RECEIVING_ADDRESS` | for payments | The `0x…` EOA that receives USDC. Public address only — never a private key. |
| `X402_NETWORK` | for payments | `eip155:84532` (Base Sepolia) or `eip155:8453` (Base mainnet). |
| `X402_FACILITATOR_URL` | for payments | Testnet: `https://x402.org/facilitator` (keyless). Mainnet: `https://api.cdp.coinbase.com/platform/v2/x402`. |
| `X402_ENABLED` | for payments | `true` to gate paid routes. Omit/`false` leaves them open — **never deploy publicly with the gate off**. |
| `PUBLIC_BASE_URL` | **yes, once deployed** | Canonical origin, e.g. `https://api.agentfilings.com`. Railway terminates TLS upstream, so without this the 402 challenge advertises an `http://` resource URL — which discovery crawlers and agents key off. |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | mainnet only | CDP API keys authenticating to the hosted mainnet facilitator (JWT auth — *not* a wallet key). |
| `PORT` | no | Injected by Railway; the server reads it automatically. |

`UPSTASH_REDIS_URL`, `STRIPE_*` are unused until those features land.

## Going live in two steps

**Step 1 — testnet:** deploy with `X402_ENABLED=true` and `X402_NETWORK=eip155:84532`.
Verify publicly:

```bash
curl -s https://<your-domain>/health
curl -s "https://<your-domain>/probe?ticker=AAPL"
curl -i "https://<your-domain>/earnings/summary?ticker=AAPL"   # expect 402 + PAYMENT-REQUIRED
```

Decode the challenge to confirm `payTo`, `amount`, `asset`, and the `extra` EIP-712
domain are correct before touching real money.

**Step 2 — mainnet:** add the CDP keys, set `X402_NETWORK=eip155:8453` and the CDP
facilitator URL. The asset and EIP-712 domain switch automatically (mainnet USDC is
named `USD Coin`, not `USDC` — handled in `packages/shared/src/x402.ts`). The first
successful settlement is what makes the service auto-list in the Bazaar catalog.

## Cost

Railway Hobby ~$5/mo. Set a hard usage cap — SEC JSON assembly is memory-sensitive.
