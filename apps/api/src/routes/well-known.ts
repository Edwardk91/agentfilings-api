import { Hono } from "hono";
import { ENDPOINTS } from "@agentfilings/shared";

// /.well-known/x402 — the x402 capability manifest (draft-hawkins-x402-dns-discovery-03).
//
// Lets an indexer resolve a bare host to "this server sells these resources over x402"
// with one GET, instead of probing each route for a 402. Crawlers were already asking
// for it: 23 requests in 39 hours across the spec path and a `.json` variant, all 404.
//
// Generated from the pricing table, like /llms.txt and /probe, so it can never list a
// route that is not both paid and actually served. Fields follow the draft:
//
//   - `updated` (RECOMMENDED) is deliberately omitted. A hardcoded timestamp goes stale
//     the first time pricing changes without someone remembering to bump it, and then it
//     tells change-detecting indexers something false. Absent is never wrong.
//   - `contact` (OPTIONAL) is omitted because it would publish a personal address.
//   - No `facilitator` object: that is for facilitators. This is a resource server.

const X402_VERSION = 2;

export function x402Manifest(baseUrl: string, enabled: boolean) {
  const router = new Hono();
  const base = baseUrl.replace(/\/$/, "");

  router.get("/", (c) => {
    // Advertising x402 resources while the payment rail is off would tell agents to pay
    // for routes that are not collecting payment. Absent is the honest answer then.
    if (!enabled) return c.notFound();

    const resources = ENDPOINTS.filter((e) => e.available && e.priceUsd > 0).map((e) => ({
      url: `${base}${e.path}`,
      method: e.method,
      description: `${e.summary} $${e.priceUsd.toFixed(2)} USDC per call.`,
    }));

    c.header("Access-Control-Allow-Origin", "*");
    c.header("Cache-Control", "public, max-age=3600");
    return c.json({
      x402Version: X402_VERSION,
      kind: "resource-server",
      name: "AgentFilings",
      description:
        "Structured US SEC/EDGAR filing data for AI agents: filings, XBRL earnings and " +
        "Form 4 insider transactions as JSON. No account or API key.",
      resources,
      docs: `${base}/llms.txt`,
    });
  });

  return router;
}
