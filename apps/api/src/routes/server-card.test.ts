import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../index";
import { LocalJsonCorpusRepo } from "../repo/corpus-repo";

const corpusDir = fileURLToPath(new URL("../../test/fixtures/corpus", import.meta.url));
const serverJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../server.json", import.meta.url)), "utf-8"),
) as Record<string, unknown> & { remotes: { url: string }[] };

type Card = {
  $schema: string;
  name: string;
  version: string;
  title: string;
  description: string;
  websiteUrl: string;
  repository: { url: string; source: string };
  remotes: { type: string; url: string; supportedProtocolVersions: string[] }[];
};

const app = createApp({ repo: new LocalJsonCorpusRepo(corpusDir) });
const getCard = async () => (await (await app.request("/mcp/server-card")).json()) as Card;

describe("MCP Server Card", () => {
  it("is served at <streamable-http-url>/server-card with the card media type", async () => {
    // Routed ahead of the /mcp transport and the payment gate: a GET here must not be
    // mistaken for an MCP GET (405) or an unpaid resource (402).
    const res = await app.request("/mcp/server-card");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/mcp-server-card+json");
  });

  it("sends the CORS and caching headers the discovery doc requires", async () => {
    const res = await app.request("/mcp/server-card");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, If-None-Match");
    expect(res.headers.get("access-control-expose-headers")).toBe("ETag");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("etag")).toMatch(/^".+"$/);
  });

  it("answers a matching If-None-Match with 304 and no body", async () => {
    const etag = (await app.request("/mcp/server-card")).headers.get("etag")!;
    const res = await app.request("/mcp/server-card", { headers: { "if-none-match": etag } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    const stale = await app.request("/mcp/server-card", { headers: { "if-none-match": '"stale"' } });
    expect(stale.status).toBe(200);
  });

  it("answers a browser preflight", async () => {
    const res = await app.request("/mcp/server-card", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("If-None-Match");
  });

  it("meets the v1 schema's constraints", async () => {
    const card = await getCard();
    expect(card.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    );
    expect(card.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(card.description.length).toBeGreaterThan(0);
    expect(card.description.length).toBeLessThanOrEqual(100);
    expect(card.title.length).toBeLessThanOrEqual(100);
    for (const r of card.remotes) expect(r.url).toMatch(/^https?:\/\/\S+$/);
    // Primitives are excluded by the spec; tools come from tools/list at runtime.
    expect(card).not.toHaveProperty("tools");
  });

  it("agrees with the published registry entry (server.json)", async () => {
    // server.json is read by the registry publisher, not this app, so nothing but this
    // test stops the two drifting apart.
    const card = await getCard();
    for (const field of ["name", "title", "description", "version", "websiteUrl"] as const) {
      expect(card[field], field).toBe(serverJson[field]);
    }
    expect(card.repository).toEqual(serverJson.repository);
    expect(new URL(card.remotes[0]!.url).pathname).toBe(new URL(serverJson.remotes[0]!.url).pathname);
  });

  it("does not contradict what a client sees once connected", async () => {
    // The spec's consistency requirement: the card is read before connecting, so a
    // version or protocol claim the handshake would contradict misleads the client.
    const card = await getCard();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    const init = (await res.json()) as {
      result: { protocolVersion: string; serverInfo: { version: string } };
    };
    expect(init.result.serverInfo.version).toBe(card.version);
    expect(card.remotes[0]!.supportedProtocolVersions).toContain(init.result.protocolVersion);

    const health = (await (await app.request("/health")).json()) as { version: string };
    expect(health.version).toBe(card.version);
  });

  it("is not served under .well-known, which the spec rejects for per-server cards", async () => {
    expect((await app.request("/.well-known/mcp/server-card")).status).toBe(404);
    expect((await app.request("/.well-known/mcp/server-card.json")).status).toBe(404);
  });
});

describe("AI Catalog", () => {
  it("points domain-level discovery at the Server Card", async () => {
    const res = await app.request("/.well-known/ai-catalog.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/ai-catalog+json");
    const catalog = (await res.json()) as {
      specVersion: string;
      entries: { identifier: string; type: string; url: string }[];
    };
    expect(catalog.specVersion).toBe("1.0");
    expect(catalog.entries).toHaveLength(1);
    const [entry] = catalog.entries;
    expect(entry!.type).toBe("application/mcp-server-card+json");
    expect(entry!.identifier).toBe("urn:air:agentfilings.com:mcp:mcp");
    expect(new URL(entry!.url).pathname).toBe("/mcp/server-card");
    // No `host` block: its identifier would promise a did:web document that does not exist.
    expect(catalog).not.toHaveProperty("host");
  });
});
