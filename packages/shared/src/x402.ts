// Verified x402 v2 constants (stack research, 2026-07-23).
//
// IMPORTANT: the build handoff (§5) describes x402 *v1* (X-PAYMENT header,
// payment requirements in the 402 body, `paymentMiddleware(payTo, routes, {url})`,
// network names "base"/"base-sepolia"). Those unscoped packages (x402-hono@1.2.0)
// are DEPRECATED. The live ecosystem is x402 v2: scoped `@x402/*@^2.19.0`, CAIP-2
// network ids, renamed headers, and the `x402ResourceServer` + scheme-handler API.
// Canonical spec: github.com/x402-foundation/x402.

/** CAIP-2 network identifiers (v2). Not the v1 short names. */
export const X402_NETWORKS = {
  baseMainnet: "eip155:8453",
  baseSepolia: "eip155:84532",
} as const;

export type X402Network = (typeof X402_NETWORKS)[keyof typeof X402_NETWORKS];

/** Native USDC (6 decimals). NEVER the legacy bridged USDbC (0xd9aAEc86...). */
export const USDC_CONTRACT: Record<X402Network, string> = {
  [X402_NETWORKS.baseMainnet]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [X402_NETWORKS.baseSepolia]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export const USDC_DECIMALS = 6;

/**
 * EIP-712 domain of each USDC contract, required in a payment option's `extra` so the
 * paying client can build the `transferWithAuthorization` signature. Without it the
 * client fails with "EIP-712 domain parameters (name, version) are required".
 *
 * These are READ FROM THE CONTRACTS and they differ per network — mainnet USDC is
 * named "USD Coin" while the Sepolia test token is "USDC". Using the wrong name
 * produces a domain mismatch and the signature will not verify.
 */
export const USDC_EIP712_DOMAIN: Record<X402Network, { name: string; version: string }> = {
  [X402_NETWORKS.baseMainnet]: { name: "USD Coin", version: "2" },
  [X402_NETWORKS.baseSepolia]: { name: "USDC", version: "2" },
};

export const X402_FACILITATORS = {
  /** Keyless, free, Base Sepolia only — dev/testnet. */
  testnet: "https://x402.org/facilitator",
  /** Base mainnet. Requires CDP_API_KEY_ID + CDP_API_KEY_SECRET (JWT auth). */
  cdpMainnet: "https://api.cdp.coinbase.com/platform/v2/x402",
} as const;

/** Payment scheme — fixed price per route (handoff §5.5: no dynamic pricing). */
export const X402_SCHEME = "exact" as const;

/**
 * Convert a USD price (e.g. 0.01) to an atomic USDC-units string.
 * Bazaar discovery requires the atomic-units string (e.g. "10000" for $0.01),
 * not just the "$0.01" shorthand.
 */
export function usdToAtomicUsdc(usd: number): string {
  return Math.round(usd * 10 ** USDC_DECIMALS).toString();
}
