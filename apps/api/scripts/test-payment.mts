/**
 * End-to-end x402 test payment on Base Sepolia.
 *
 *   $env:TEST_BUYER_PRIVATE_KEY="0x..."      # your terminal only — never a file
 *   pnpm exec tsx apps/api/scripts/test-payment.mts
 *
 * Acts as a paying agent: requests a paid endpoint, receives the 402 challenge, signs
 * an EIP-3009 authorization, and retries. The facilitator verifies + settles on-chain
 * (it pays the gas — the buyer needs USDC only, no ETH).
 *
 * By default it boots the API in-process. Pass a URL to test a DEPLOYED service:
 *   pnpm exec tsx apps/api/scripts/test-payment.mts https://your-app.up.railway.app
 *
 * The private key is read from the environment, never written to disk or logged.
 * Use a THROWAWAY testnet-only wallet.
 */
import { serve } from "@hono/node-server";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createPublicClient, http, formatUnits, erc20Abi } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnvFile } from "../src/load-env";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const PORT = 8910;
const PATH = "/earnings/summary?ticker=AAPL"; // $0.02

/** Optional target: a deployed base URL. Omitted => boot the API locally. */
const targetUrl = process.argv[2]?.replace(/\/$/, "");

loadEnvFile();

/** Prompt for the key on stdin so it never needs shell quoting or a file. */
async function promptForKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    // Non-interactive (CI, piped): don't hang waiting on input that cannot arrive.
    console.error(
      "\nNo TEST_BUYER_PRIVATE_KEY set and no interactive terminal to prompt on.\n" +
        "Run this from a normal terminal, or set TEST_BUYER_PRIVATE_KEY.\n",
    );
    process.exit(1);
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\nPaste your THROWAWAY testnet private key (it is not saved anywhere).");
    console.log("Generate one with: pnpm exec tsx apps/api/scripts/new-test-wallet.mts\n");
    return (await rl.question("Private key: ")).trim();
  } finally {
    rl.close();
  }
}

const rawKey = process.env.TEST_BUYER_PRIVATE_KEY?.trim() || (await promptForKey());
if (!rawKey) {
  console.error("\nNo private key provided — nothing to pay with.\n");
  process.exit(1);
}
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey)) {
  console.error(
    "\nThat does not look like a private key (expected 64 hex characters, optionally 0x-prefixed).\n" +
      "Tip: if you pasted it into PowerShell unquoted and saw a numeric-constant error, just run\n" +
      "this script with no arguments and paste at the prompt instead.\n",
  );
  process.exit(1);
}
const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;

const account = privateKeyToAccount(privateKey);
console.log("Buyer wallet (public address):", account.address);

// When testing a deployed service the seller address comes from its own challenge,
// so a local .env value is only required for the in-process mode.
const seller = process.env.X402_RECEIVING_ADDRESS;
console.log("Target:                       ", targetUrl ?? "(local, in-process)");
console.log("Seller wallet (payTo):        ", seller ?? "(from the service's challenge)");
if (!targetUrl && !seller) {
  console.error("X402_RECEIVING_ADDRESS is not set in .env — nothing to pay to.");
  process.exit(1);
}
if (seller && seller.toLowerCase() === account.address.toLowerCase()) {
  console.error("\nBuyer and seller are the same wallet. Use a separate throwaway wallet to pay.\n");
  process.exit(1);
}

// --- Check the buyer's test-USDC balance before attempting payment -----------
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const balance = await publicClient.readContract({
  address: USDC_BASE_SEPOLIA,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [account.address],
});
console.log("Buyer test-USDC balance:      ", formatUnits(balance, 6), "USDC");

if (balance === 0n) {
  console.error(
    "\nThis wallet has no test USDC on Base Sepolia.\n" +
      "Get free test USDC at https://faucet.circle.com (choose Base Sepolia) and send it to:\n" +
      `  ${account.address}\n\n` +
      "You do NOT need testnet ETH — the facilitator pays the gas.\n",
  );
  process.exit(1);
}

// --- Target: a deployed service, or the API booted here with the gate ON -----
let server: ReturnType<typeof serve> | undefined;
let base: string;

if (targetUrl) {
  base = targetUrl;
} else {
  process.env.X402_ENABLED = "true";
  process.env.X402_NETWORK = process.env.X402_NETWORK || "eip155:84532";
  process.env.X402_FACILITATOR_URL =
    process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
  const { createApp } = await import("../src/index");
  server = serve({ fetch: createApp().fetch, port: PORT });
  base = `http://localhost:${PORT}`;
}

async function main() {
  // Unpaid request should be refused with a 402 challenge.
  const unpaid = await fetch(`${base}${PATH}`);
  console.log("\n1. Unpaid request ->", unpaid.status, unpaid.status === 402 ? "(correctly refused)" : "(UNEXPECTED)");

  // Show who the service says to pay — confirm it matches the intended wallet.
  const challengeHeader = unpaid.headers.get("payment-required");
  if (challengeHeader) {
    const challenge = JSON.parse(Buffer.from(challengeHeader, "base64").toString("utf8"));
    const terms = challenge.accepts[0];
    console.log(`   Service asks for ${terms.amount} atomic units to ${terms.payTo} on ${terms.network}`);
    if (seller && terms.payTo.toLowerCase() !== seller.toLowerCase()) {
      throw new Error(`Service payTo ${terms.payTo} does not match configured ${seller}`);
    }
  }

  // Paying agent: signs the challenge and retries automatically.
  const client = registerExactEvmScheme(new x402Client(), { signer: account });
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log("2. Paying $0.02 in test USDC and retrying...");
  const paid = await fetchWithPayment(`${base}${PATH}`);
  console.log("3. Paid request ->", paid.status);

  const settlement = paid.headers.get("payment-response");
  if (settlement) {
    const decoded = JSON.parse(Buffer.from(settlement, "base64").toString("utf8"));
    console.log("4. Settlement:", JSON.stringify(decoded, null, 2));
    if (decoded.transaction) {
      console.log("   Explorer: https://sepolia.basescan.org/tx/" + decoded.transaction);
    }
  } else {
    console.log("4. No PAYMENT-RESPONSE header returned.");
  }

  const body = (await paid.json()) as { data?: { ticker?: string; count?: number } };
  console.log("5. Data received:", body.data ? `${body.data.ticker} — ${body.data.count} periods` : JSON.stringify(body).slice(0, 200));

  const after = await publicClient.readContract({
    address: USDC_BASE_SEPOLIA,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log("6. Buyer balance after:", formatUnits(after, 6), "USDC (spent", formatUnits(balance - after, 6) + ")");

  console.log(
    paid.status === 200 && body.data ? "\nPAYMENT TEST PASSED\n" : "\nPAYMENT TEST DID NOT COMPLETE\n",
  );
}

try {
  await main();
} catch (err) {
  console.error("\nPAYMENT TEST FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  server?.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
