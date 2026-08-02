import { Hono } from "hono";
import { ENDPOINTS, type EndpointSpec } from "@agentfilings/shared";
import type { Env } from "../env";

// Machine-readable service description.
//
// This is a discovery HARD REQUIREMENT, not documentation politeness: x402scan's
// crawler fetches exactly `${origin}/openapi.json` and aborts registration if it is
// missing or lists no routes. Generated from the shared pricing table so the spec
// cannot drift from what the service actually sells.

interface ParamSpec {
  name: string;
  required?: boolean;
  schema: Record<string, unknown>;
  description: string;
}

const PARAMS: Record<string, ParamSpec[]> = {
  probe: [
    {
      name: "ticker",
      schema: { type: "string" },
      description: "Optional ticker to check coverage for, e.g. AAPL.",
    },
  ],
  filings_latest: [
    { name: "ticker", required: true, schema: { type: "string" }, description: "Ticker symbol, e.g. AAPL." },
    { name: "form", schema: { type: "string" }, description: "Optional SEC form filter, e.g. 10-K, 10-Q, 8-K, 4." },
    {
      name: "limit",
      schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      description: "Maximum filings to return.",
    },
  ],
  earnings_summary: [
    { name: "ticker", required: true, schema: { type: "string" }, description: "Ticker symbol, e.g. AAPL." },
    {
      name: "period",
      schema: { type: "string" },
      description:
        'Optional filter: "annual", "quarterly", "interim", a fiscal year ("2025"/"FY2025"), or an SEC frame ("CY2026Q1").',
    },
  ],
  insiders: [
    { name: "ticker", required: true, schema: { type: "string" }, description: "Ticker symbol, e.g. AAPL." },
    {
      name: "since",
      schema: { type: "string", format: "date" },
      description: "Optional ISO date (YYYY-MM-DD); only transactions on or after it.",
    },
  ],
};

const PAYMENT_NETWORK_LABEL = "base";

function operationFor(ep: EndpointSpec): Record<string, unknown> {
  const paid = ep.priceUsd > 0;
  const responses: Record<string, unknown> = {
    "200": {
      description: "Success. Envelope: { data, meta } where meta carries source and freshness.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } },
    },
  };
  if (PARAMS[ep.id]?.some((p) => p.required)) {
    responses["400"] = {
      description: "Missing or invalid parameter.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    };
  }
  if (paid) {
    responses["402"] = {
      description:
        "Payment required. Payment requirements are returned in the base64 PAYMENT-REQUIRED header (x402 v2), not the body.",
    };
    responses["404"] = {
      description: "No coverage for the requested ticker. Check /probe first — it is free.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    };
  }

  return {
    operationId: ep.id,
    summary: ep.summary,
    ...(PARAMS[ep.id]
      ? {
          parameters: PARAMS[ep.id]!.map((p) => ({
            name: p.name,
            in: "query",
            required: Boolean(p.required),
            schema: p.schema,
            description: p.description,
          })),
        }
      : {}),
    security: [],
    ...(paid
      ? {
          // Shape matters: `protocols` is an array of OBJECTS keyed by protocol name,
          // not strings. A wrong shape here fails validation for the whole block, so
          // the price silently disappears too and agents cannot budget the call.
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: ep.priceUsd.toFixed(2) },
            protocols: [
              {
                x402: {
                  network: PAYMENT_NETWORK_LABEL,
                  asset: "USDC",
                  scheme: "exact",
                },
              },
            ],
          },
        }
      : {}),
    responses,
  };
}

export function buildOpenApiDocument(env: Env): Record<string, unknown> {
  // Path-free server URL: a path here would be prefixed onto every route.
  const serverUrl = (env.PUBLIC_BASE_URL ?? "https://api.agentfilings.com").replace(/\/$/, "");

  const paths: Record<string, unknown> = {};
  for (const ep of ENDPOINTS.filter((e) => e.available)) {
    paths[ep.path] = { [ep.method.toLowerCase()]: operationFor(ep) };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "AgentFilings",
      version: "1.0.0",
      description:
        "Structured US SEC/EDGAR filing data for autonomous agents: filings index, " +
        "XBRL-derived earnings summaries, and Form 4 insider transactions as clean JSON. " +
        "Public-domain SEC data, pre-parsed and normalized. Paid endpoints use x402 " +
        "(USDC on Base); /health and /probe are free. Call /probe first to check coverage " +
        "and pricing before paying.",
      ...(env.SEC_CONTACT_EMAIL ? { contact: { email: env.SEC_CONTACT_EMAIL } } : {}),
      license: { name: "Data: US SEC EDGAR (public domain)" },
      // Agent-readable operating instructions (read by discovery tooling).
      "x-guidance":
        "Call GET /probe?ticker=SYMBOL first — it is free and tells you whether the " +
        "ticker is covered, how much data exists, how fresh it is, and the exact price " +
        "of each endpoint. If ticker_coverage.covered is false, do not pay: paid " +
        "endpoints will return 404. Paid endpoints answer HTTP 402 with payment " +
        "requirements in the base64 PAYMENT-REQUIRED header (x402 v2, USDC on Base " +
        "mainnet); pay and retry the identical request. Every response is " +
        "{ data, meta }, and meta carries the SEC source accession and timestamps so " +
        "figures can be traced back to the original filing. Coverage is US public " +
        "companies filing with SEC EDGAR and is still expanding — call /probe for " +
        "the authoritative answer on any specific ticker rather than assuming an index.",
    },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      schemas: {
        Envelope: {
          type: "object",
          required: ["data", "meta"],
          properties: {
            data: { description: "Endpoint-specific payload." },
            meta: {
              type: "object",
              required: ["retrieved_at", "cache"],
              properties: {
                source_api: { type: "string" },
                source_accession: { type: "string" },
                filed_at: { type: ["string", "null"] },
                retrieved_at: { type: "string", format: "date-time" },
                cache: { type: "string", enum: ["hit", "miss"] },
              },
            },
          },
        },
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "hint"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                hint: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}

export function openapi(env: Env) {
  const router = new Hono();
  const doc = buildOpenApiDocument(env);
  router.get("/", (c) => c.json(doc));
  return router;
}
