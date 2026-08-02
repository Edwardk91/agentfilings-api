// Env access. Reads from process.env; does not hard-fail at Stage 0 so /health
// and /probe run without a full secret set. Paid paths will assert their own
// required vars when they are wired.

export interface Env {
  PORT: number;
  DATABASE_URL?: string;
  UPSTASH_REDIS_URL?: string;
  /** External EOA that receives USDC — the x402 `payTo`. Never a private key. */
  X402_RECEIVING_ADDRESS?: string;
  X402_FACILITATOR_URL?: string;
  /** CAIP-2 network id, e.g. eip155:84532 (Sepolia) / eip155:8453 (mainnet). */
  X402_NETWORK: string;
  /** Canonical public origin, e.g. https://api.agentfilings.com. Used for the x402
   * resource URL, which must be absolute and HTTPS for discovery crawlers. */
  PUBLIC_BASE_URL?: string;
  /** CDP API keys — mainnet facilitator only (JWT auth, not a wallet key). */
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  SEC_CONTACT_EMAIL?: string;
}

export function loadEnv(): Env {
  return {
    PORT: Number(process.env.PORT ?? 8080),
    DATABASE_URL: process.env.DATABASE_URL,
    UPSTASH_REDIS_URL: process.env.UPSTASH_REDIS_URL,
    X402_RECEIVING_ADDRESS: process.env.X402_RECEIVING_ADDRESS,
    X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
    X402_NETWORK: process.env.X402_NETWORK ?? "eip155:84532",
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    CDP_API_KEY_ID: process.env.CDP_API_KEY_ID,
    CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    SEC_CONTACT_EMAIL: process.env.SEC_CONTACT_EMAIL,
  };
}

/** Assert a var is present, or throw a clear error naming it. */
export function requireEnv(env: Env, key: keyof Env): string {
  const value = env[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var: ${String(key)}`);
  }
  return String(value);
}
