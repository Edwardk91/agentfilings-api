/**
 * Status watch: has anyone paid yet, and is the directory PR merged?
 *
 *   pnpm exec tsx apps/api/scripts/watch.mts
 *
 * Checks, in order:
 *  1. Service health + that paid routes still issue a correct mainnet challenge.
 *  2. On-chain: USDC received by the receiving wallet on Base mainnet (the first
 *     real settlement), listing each incoming transfer.
 *  3. The awesome-x402 pull request state (via gh, if available).
 *
 * Read-only. Safe to run on a schedule.
 */
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { createPublicClient, erc20Abi, formatUnits, http, parseAbiItem } from "viem";
import { base } from "viem/chains";
import { USDC_CONTRACT, X402_NETWORKS } from "@agentfilings/shared";
import { loadEnvFile } from "../src/load-env";

const exec = promisify(execCb);

loadEnvFile();

const BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://api.agentfilings.com";
const SELLER = process.env.X402_RECEIVING_ADDRESS;
const PR = { repo: "xpaysh/awesome-x402", number: 1010 };
const USDC = USDC_CONTRACT[X402_NETWORKS.baseMainnet] as `0x${string}`;

const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(22)} ${String(value)}`);

console.log(`\nAgentFilings status — ${new Date().toISOString()}\n`);

// ---- 1. Service ------------------------------------------------------------
console.log("Service");
try {
  const health = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(15000) });
  line("health", health.status);

  const paid = await fetch(`${BASE_URL}/earnings/summary?ticker=AAPL`, {
    signal: AbortSignal.timeout(15000),
  });
  const header = paid.headers.get("payment-required");
  if (paid.status === 402 && header) {
    const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      accepts: { network: string; amount: string; payTo: string }[];
    };
    const a = challenge.accepts[0]!;
    line("paid route", `402, ${a.network}, $${(Number(a.amount) / 1e6).toFixed(2)} -> ${a.payTo}`);
    if (a.network !== X402_NETWORKS.baseMainnet) line("WARNING", "not on Base mainnet");
  } else {
    line("paid route", `UNEXPECTED ${paid.status} (no challenge)`);
  }

  const probe = await fetch(`${BASE_URL}/probe`, { signal: AbortSignal.timeout(15000) });
  const p = (await probe.json()) as {
    data: { coverage: { companies_covered: number }; freshness: { last_ingest_at: string } };
  };
  line("coverage", `${p.data.coverage.companies_covered} companies`);
  // Postgres renders "2026-07-26 11:52:18.7+00"; Date needs "T" and a 2-digit offset.
  const iso = p.data.freshness.last_ingest_at
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  const ingested = new Date(iso);
  const hours = Number.isNaN(ingested.getTime())
    ? null
    : (Date.now() - ingested.getTime()) / 3.6e6;
  line(
    "last ingest",
    `${p.data.freshness.last_ingest_at}${hours === null ? "" : ` (${hours.toFixed(1)}h ago)`}`,
  );
  if (hours !== null && hours > 24) {
    line("WARNING", "data is stale — the scheduled sync may be failing");
  }
} catch (e) {
  line("ERROR", e instanceof Error ? e.message : e);
}

// ---- 2. Revenue ------------------------------------------------------------
console.log("\nRevenue (Base mainnet)");
if (!SELLER) {
  line("skipped", "X402_RECEIVING_ADDRESS not set");
} else {
  try {
    const client = createPublicClient({ chain: base, transport: http() });
    const balance = await client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [SELLER as `0x${string}`],
    });
    line("wallet", SELLER);
    line("USDC balance", formatUnits(balance, 6));

    // Public RPCs cap eth_getLogs ranges; walk back in safe chunks.
    const latest = await client.getBlockNumber();
    const ev = parseAbiItem(
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    );
    const received: { value: bigint; from: string; hash: string; block: bigint }[] = [];
    for (let i = 0; i < 5; i += 1) {
      const to = latest - BigInt(i * 500);
      const from = to - 499n;
      try {
        const logs = await client.getLogs({
          address: USDC,
          event: ev,
          args: { to: SELLER as `0x${string}` },
          fromBlock: from,
          toBlock: to,
        });
        for (const l of logs) {
          received.push({
            value: l.args.value!,
            from: l.args.from!,
            hash: l.transactionHash,
            block: l.blockNumber,
          });
        }
      } catch {
        break; // RPC range limit differs per provider; balance above is the source of truth
      }
    }
    if (balance === 0n) {
      line("payments", "none yet — no agent has paid on mainnet");
    } else {
      line("payments", `${received.length} recent incoming transfer(s) found`);
      for (const r of received.sort((a, b) => Number(a.block - b.block))) {
        console.log(
          `    ${formatUnits(r.value, 6)} USDC from ${r.from}\n      https://basescan.org/tx/${r.hash}`,
        );
      }
    }
  } catch (e) {
    line("ERROR", e instanceof Error ? e.message : e);
  }
}

// ---- 3. Directory PR -------------------------------------------------------
console.log("\nDirectory listing");
try {
  const { stdout } = await exec(
    `gh pr view ${PR.number} --repo ${PR.repo} --json state,mergedAt,url`,
  );
  const pr = JSON.parse(stdout) as { state: string; mergedAt: string | null; url: string };
  line("awesome-x402 PR", `${pr.state}${pr.mergedAt ? ` (merged ${pr.mergedAt})` : ""}`);
  line("", pr.url);
} catch {
  line("awesome-x402 PR", "could not query (gh unavailable or not authenticated)");
}
console.log("");
