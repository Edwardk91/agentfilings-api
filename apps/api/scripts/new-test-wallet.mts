/**
 * Generate a THROWAWAY testnet-only wallet for the x402 payment test.
 *
 *   pnpm exec tsx apps/api/scripts/new-test-wallet.mts
 *
 * Prints a fresh private key and its address. The key is generated locally and is
 * never saved anywhere — copy it, use it for the test, then forget it. Never fund
 * this wallet with real money and never reuse it for anything else.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = generatePrivateKey();
const account = privateKeyToAccount(key);

console.log("");
console.log("  Throwaway test wallet (Base Sepolia only)");
console.log("  ─────────────────────────────────────────────────────────────────");
console.log("  ADDRESS      (paste into the faucet):");
console.log("    " + account.address);
console.log("");
console.log("  PRIVATE KEY  (keep secret — never paste into chat or a file):");
console.log("    " + key);
console.log("  ─────────────────────────────────────────────────────────────────");
console.log("");
console.log("  Next: fund the ADDRESS at https://faucet.circle.com (Base Sepolia),");
console.log("  then run:  corepack pnpm@9.15.0 exec tsx apps/api/scripts/test-payment.mts");
console.log("");
