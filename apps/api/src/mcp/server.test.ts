import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { createPaymentStack } from "../payments/x402";
import { LocalJsonCorpusRepo } from "../repo/corpus-repo";
import { createMcpPaidWrapper } from "./payments";
import { createMcpServer } from "./server";

const corpusDir = fileURLToPath(new URL("../../test/fixtures/corpus", import.meta.url));

async function connect(server: ReturnType<typeof createMcpServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function connectClient(): Promise<Client> {
  return connect(createMcpServer(new LocalJsonCorpusRepo(corpusDir)));
}

function paidEnv(): Env {
  return {
    PORT: 8080,
    X402_NETWORK: "eip155:84532",
    X402_FACILITATOR_URL: "https://x402.org/facilitator",
    X402_RECEIVING_ADDRESS: "0x000000000000000000000000000000000000dEaD",
  };
}

interface LooseToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function toolJson(result: unknown): unknown {
  const r = result as LooseToolResult;
  const item = r.content.find((c) => c.type === "text");
  return JSON.parse(item?.text ?? "{}");
}

describe("MCP server", () => {
  it("lists the expected tools with prices stated in descriptions", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "probe_coverage",
        "get_latest_filings",
        "get_earnings_summary",
        "get_insider_transactions",
      ]),
    );
    const earnings = tools.find((t) => t.name === "get_earnings_summary");
    expect(earnings?.description).toContain("$0.02");
    await client.close();
  });

  it("get_insider_transactions returns transactions for a covered ticker", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "get_insider_transactions",
      arguments: { ticker: "AAPL" },
    });
    const data = toolJson(res) as { count: number; transactions: unknown[] };
    expect(data.count).toBe(3);
    expect(data.transactions).toHaveLength(3);
    await client.close();
  });

  it("get_earnings_summary returns periods for a covered ticker", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "get_earnings_summary", arguments: { ticker: "AAPL" } });
    const data = toolJson(res) as { ticker: string; count: number };
    expect(data.ticker).toBe("AAPL");
    expect(data.count).toBe(22);
    await client.close();
  });

  it("get_latest_filings filters by form", async () => {
    const client = await connectClient();
    const res = await client.callTool({
      name: "get_latest_filings",
      arguments: { ticker: "AAPL", form: "10-Q" },
    });
    const data = toolJson(res) as { filings: { form: string }[] };
    expect(data.filings.length).toBeGreaterThan(0);
    expect(data.filings.every((f) => f.form === "10-Q")).toBe(true);
    await client.close();
  });

  it("returns an error result for an uncovered ticker", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "get_latest_filings", arguments: { ticker: "ZZZZ" } });
    expect((res as LooseToolResult).isError).toBe(true);
    const data = toolJson(res) as { error: { code: string } };
    expect(data.error.code).toBe("coverage_missing");
    await client.close();
  });

  it("probe_coverage is free and lists per-tool prices", async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: "probe_coverage", arguments: {} });
    const data = toolJson(res) as { pricing: { tool: string; price_usd: number }[] };
    const earnings = data.pricing.find((p) => p.tool === "get_earnings_summary");
    expect(earnings?.price_usd).toBe(0.02);
    await client.close();
  });

  it("gives each paid tool its own resource identifier", async () => {
    // The replay guard binds a payment to its resource id. If every paid tool
    // advertised the same placeholder (mcp://tool/paid_tool), a $0.01 tool and a
    // $0.02 tool would be indistinguishable to the guard — exactly the
    // cross-resource substitution it exists to prevent.
    const env = paidEnv();
    const { resourceServer } = createPaymentStack(env);
    const wrapPaid = createMcpPaidWrapper(env, resourceServer);
    const server = createMcpServer(new LocalJsonCorpusRepo(corpusDir), wrapPaid);
    const client = await connect(server);

    const seen = new Map<string, string>();
    for (const tool of ["get_latest_filings", "get_earnings_summary"]) {
      const res = await client.callTool({ name: tool, arguments: { ticker: "AAPL" } });
      const payload = toolJson(res) as { resource?: { url?: string } };
      const url = payload.resource?.url ?? "";
      expect(url).toBe(`mcp://tool/${tool}`);
      expect(url).not.toContain("paid_tool");
      seen.set(tool, url);
    }
    // ...and they differ from each other.
    expect(new Set(seen.values()).size).toBe(seen.size);
    await client.close();
  });

  it("registers tools when paid tools are payment-wrapped", async () => {
    const env = paidEnv();
    const { resourceServer } = createPaymentStack(env);
    const wrapPaid = createMcpPaidWrapper(env, resourceServer);
    const server = createMcpServer(new LocalJsonCorpusRepo(corpusDir), wrapPaid);
    const client = await connect(server);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["probe_coverage", "get_latest_filings", "get_earnings_summary"]),
    );
    await client.close();
  });
});
