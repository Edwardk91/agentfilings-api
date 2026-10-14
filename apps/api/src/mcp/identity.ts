// The server's public identity, in one place.
//
// The same facts are published in four places: the MCP registry entry (server.json at
// the repo root), the Server Card, the `serverInfo` returned by the MCP handshake, and
// /health. The Server Card spec requires the card not to contradict what a client sees
// once connected, and until this module existed the handshake reported version 0.0.0
// against a registry entry at 1.1.0 — a placeholder nobody had updated.
//
// server.json is read by the registry's publisher CLI, not by this app, so it cannot
// import from here. `server-card.test.ts` fails if the two disagree instead.

export const SERVER_IDENTITY = {
  /** Reverse-DNS name: the registry entry and the Server Card. */
  name: "com.agentfilings/mcp",
  /**
   * Name reported in the MCP handshake's `serverInfo`. Kept short on purpose: the spec
   * pins the card's `version` to the handshake's, but not its `name`, and clients show
   * this string to people.
   */
  shortName: "agentfilings",
  title: "AgentFilings",
  /** Max 100 characters in both the registry schema and the Server Card schema. */
  description:
    "SEC filings, XBRL earnings, Form 4 insiders for ~2,800 US SEC filers. x402 pay-per-call, no signup.",
  version: "1.1.0",
  websiteUrl: "https://api.agentfilings.com",
  repository: { url: "https://github.com/Edwardk91/agentfilings-api", source: "github" },
} as const;
