import { createHash } from "node:crypto";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { SERVER_IDENTITY } from "../mcp/identity";

// MCP Server Card and AI Catalog (SEP-2127; normative detail in the
// modelcontextprotocol/experimental-ext-server-card repository, docs/discovery.md).
//
// A client discovering MCP servers on a domain fetches /.well-known/ai-catalog.json,
// picks the entries typed as Server Cards, and follows each entry's `url` to the card,
// which says where and how to connect before any MCP exchange happens.
//
// Where things live, per the spec:
//   - The card sits at `<streamable-http-url>/server-card`, the one location MCP
//     reserves. The spec explicitly rejects `/.well-known/mcp/server-card`, which some
//     crawlers still request from older drafts: `.well-known` is for site-wide
//     metadata, and a card is per-server.
//   - The catalog is the site-wide document, so it does belong under `.well-known`.
//
// What the card deliberately leaves out:
//   - Tools. The spec excludes primitives because a static document cannot track a
//     server's runtime surface; clients call `tools/list`.
//   - Headers. No credential is required to connect, and the subscription key the
//     billing code can accept is not live, so advertising it would be false.
//   - The catalog's `host` block. Its identifier would be `did:web:agentfilings.com`,
//     which promises a DID document that does not exist.

const CARD_TYPE = "application/mcp-server-card+json";
const CATALOG_TYPE = "application/ai-catalog+json";
const CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";

// Required on the card endpoint by the discovery doc's CORS section.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET",
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
  "Access-Control-Expose-Headers": "ETag",
} as const;

/**
 * Serve a static JSON document with the caching the discovery doc asks for: a
 * one-hour Cache-Control, a content-derived ETag, and 304 on a matching If-None-Match.
 * The document is built once, so the ETag is stable for the life of the process and
 * changes exactly when the content does.
 */
function staticJson(doc: unknown, mediaType: string) {
  const router = new Hono();
  const body = JSON.stringify(doc);
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  const headers = { ...CORS, "Cache-Control": "public, max-age=3600", ETag: etag };

  // A browser client sending If-None-Match makes this a non-simple request, so it
  // preflights; answer it rather than letting the preflight fall through to a 404.
  router.options("/", (c) => c.body(null, 204, { ...CORS, "Access-Control-Max-Age": "86400" }));
  router.get("/", (c) => {
    const inm = c.req.header("if-none-match");
    if (inm && inm.split(",").some((t) => t.trim() === etag || t.trim() === "*")) {
      return c.body(null, 304, headers);
    }
    return c.body(body, 200, { ...headers, "Content-Type": mediaType });
  });
  return router;
}

export function buildServerCard(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  return {
    $schema: CARD_SCHEMA,
    name: SERVER_IDENTITY.name,
    version: SERVER_IDENTITY.version,
    title: SERVER_IDENTITY.title,
    description: SERVER_IDENTITY.description,
    websiteUrl: SERVER_IDENTITY.websiteUrl,
    repository: { ...SERVER_IDENTITY.repository },
    remotes: [
      {
        type: "streamable-http" as const,
        url: `${base}/mcp`,
        // Taken from the SDK that actually negotiates, so the card cannot claim a version
        // the handshake would refuse — the spec calls overstatement here a downgrade vector.
        supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      },
    ],
  };
}

export function buildAiCatalog(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  // `com.agentfilings/mcp` -> publisher `agentfilings.com`, namespace `mcp`, name `mcp`,
  // following the spec's `com.example/weather` -> `urn:air:example.com:mcp:weather`.
  const [namespace, name] = SERVER_IDENTITY.name.split("/") as [string, string];
  const publisher = namespace.split(".").reverse().join(".");
  return {
    specVersion: "1.0",
    entries: [
      {
        identifier: `urn:air:${publisher}:mcp:${name}`,
        type: CARD_TYPE,
        url: `${base}/mcp/server-card`,
        tags: ["sec", "edgar", "finance", "filings", "x402"],
      },
    ],
  };
}

export const serverCard = (baseUrl: string) => staticJson(buildServerCard(baseUrl), CARD_TYPE);
export const aiCatalog = (baseUrl: string) => staticJson(buildAiCatalog(baseUrl), CATALOG_TYPE);
