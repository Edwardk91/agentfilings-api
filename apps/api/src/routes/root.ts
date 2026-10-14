import { Hono } from "hono";
import { ENDPOINTS, SUBSCRIPTION } from "@agentfilings/shared";

// The bare origin and llms.txt.
//
// `/` used to 404. That hurts twice: discovery crawlers scrape it for a title and
// icon (a listing with neither renders bare), and humans reviewing a directory
// submission click it and see a dead link.
//
// Content negotiation: agents asking for JSON get the machine description; browsers
// get a small HTML page. Same facts either way.

const PAID = ENDPOINTS.filter((e) => e.available && e.priceUsd > 0);
const FREE = ENDPOINTS.filter((e) => e.available && e.priceUsd === 0);

const DESCRIPTION =
  "Structured US SEC/EDGAR filing data for AI agents — filings, XBRL-derived " +
  "earnings, and Form 4 insider transactions as clean JSON.";

function serviceJson(base: string) {
  return {
    service: "AgentFilings",
    description: DESCRIPTION,
    documentation: `${base}/openapi.json`,
    llms_txt: `${base}/llms.txt`,
    mcp: `${base}/mcp`,
    payment: {
      // Two rails. Agents with a wallet and no account use x402; humans and anything
      // holding an API key use the subscription. Both hit the same endpoints.
      per_call: { protocol: "x402", asset: "USDC", network: "Base" },
      subscription: {
        price_usd_per_month: SUBSCRIPTION.priceUsdPerMonth,
        name: SUBSCRIPTION.name,
        subscribe: `${base}/billing/subscribe`,
        auth: "Send the key as `x-api-key` or `Authorization: Bearer …`.",
      },
    },
    free_endpoints: FREE.map((e) => ({ path: e.path, summary: e.summary })),
    paid_endpoints: PAID.map((e) => ({
      path: e.path,
      price_usd: e.priceUsd,
      summary: e.summary,
    })),
    start_here: `${base}/probe?ticker=AAPL`,
  };
}

function html(base: string): string {
  const row = (e: (typeof ENDPOINTS)[number]) =>
    `<tr><td><code>${e.method} ${e.path}</code></td><td>${
      e.priceUsd > 0 ? "$" + e.priceUsd.toFixed(2) : "free"
    }</td><td>${e.summary}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentFilings — SEC filing data for AI agents</title>
<meta name="description" content="${DESCRIPTION}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:title" content="AgentFilings">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:type" content="website">
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
      max-width:52rem;margin:0 auto;padding:2.5rem 1.25rem;}
 h1{font-size:1.9rem;margin:0 0 .3rem} .sub{opacity:.75;margin:0 0 2rem}
 table{border-collapse:collapse;width:100%;margin:1rem 0}
 td,th{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #8883;vertical-align:top}
 code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
 a{color:inherit}
 .plans{display:flex;gap:1rem;flex-wrap:wrap;margin:1.5rem 0}
 .plan{flex:1 1 16rem;border:1px solid #8884;border-radius:10px;padding:1.1rem 1.2rem}
 .plan h2{font-size:1.05rem;margin:0 0 .2rem}
 .price{font-size:1.6rem;font-weight:600;margin:.2rem 0 .5rem}
 .plan p{margin:.4rem 0;font-size:.94rem;opacity:.85}
 .cta{display:inline-block;margin-top:.7rem;padding:.5rem .9rem;border-radius:7px;
      background:#12305a;color:#fff;text-decoration:none;font-weight:500}
 @media (prefers-color-scheme:dark){.cta{background:#4d7fc7;color:#08131f}}
</style></head><body>
<h1>AgentFilings</h1>
<p class="sub">${DESCRIPTION}</p>

<div class="plans">
  <div class="plan">
    <h2>${SUBSCRIPTION.name}</h2>
    <div class="price">$${SUBSCRIPTION.priceUsdPerMonth}<span style="font-size:.9rem;font-weight:400">/month</span></div>
    <p>Unlimited calls to every endpoint below, and every MCP tool. One API key, no per-call charges.</p>
    <p>Card payment. Cancel any time, self-serve.</p>
    <a class="cta" href="/billing/subscribe">Subscribe</a>
  </div>
  <div class="plan">
    <h2>Pay per call</h2>
    <div class="price">$0.01<span style="font-size:.9rem;font-weight:400">–$0.05/call</span></div>
    <p>For autonomous agents: <strong>x402</strong> in USDC on Base. No account, no signup, no API key.</p>
    <p>Send a request, get a 402 with payment terms, pay, retry.</p>
    <a class="cta" href="/probe?ticker=AAPL">Check coverage free</a>
  </div>
</div>

<p>Either way, start with <a href="/probe?ticker=AAPL"><code>/probe</code></a> — it is free and tells you
exactly what data exists for a ticker <em>before</em> you spend anything.</p>
<table><tr><th>Endpoint</th><th>Per call</th><th>What it returns</th></tr>
${[...FREE, ...PAID].map(row).join("\n")}
</table>
<p><strong>Why this and not the free tools:</strong> restated figures are reconciled to the latest
filed value, each period keeps the fiscal year from its <em>original</em> filing rather than
inheriting a later filing's label, and ticker→CIK resolution rejects post-reorganization shells.
Those three are wrong in the widely used open-source alternatives.</p>
<p>Machine-readable: <a href="${base}/openapi.json">openapi.json</a> ·
<a href="${base}/llms.txt">llms.txt</a> · MCP at <code>${base}/mcp</code></p>
<p>Data source: <a href="https://www.sec.gov/edgar">SEC EDGAR</a> (public domain), refreshed on a daily rotation — company metadata every ~3 days, Form 4 every ~19 days.</p>
</body></html>`;
}

// Minimal mark: a document glyph. Inline SVG so there is no binary asset to ship,
// and catalogs that scrape an icon find one instead of rendering the listing bare.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="12" fill="#12305a"/>
<path d="M20 14h16l10 10v26a2 2 0 0 1-2 2H20a2 2 0 0 1-2-2V16a2 2 0 0 1 2-2z" fill="#f5f7fa"/>
<path d="M36 14l10 10H38a2 2 0 0 1-2-2z" fill="#c8d4e4"/>
<rect x="24" y="34" width="4" height="12" rx="1" fill="#12305a"/>
<rect x="30" y="29" width="4" height="17" rx="1" fill="#12305a"/>
<rect x="36" y="37" width="4" height="9" rx="1" fill="#12305a"/>
</svg>`;

export function root(baseUrl: string) {
  const router = new Hono();
  const base = baseUrl.replace(/\/$/, "");

  router.get("/", (c) => {
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("application/json") && !accept.includes("text/html")) {
      return c.json(serviceJson(base));
    }
    return c.html(html(base));
  });

  for (const path of ["/favicon.svg", "/favicon.ico"]) {
    router.get(path, (c) =>
      c.body(FAVICON_SVG, 200, {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=86400",
      }),
    );
  }

  // A missing robots.txt is permissive by default, so this is not about unblocking
  // crawlers — it is about pointing them at the machine-readable surfaces. The
  // agents that might buy this data do not browse; they are answered by models
  // whose index was built by these crawlers. llms.txt and openapi.json are what we
  // want in that index, so name them explicitly rather than hoping they are found.
  router.get("/robots.txt", (c) =>
    c.text(
      [
        "# AgentFilings — structured SEC/EDGAR data for AI agents.",
        "# Machine-readable descriptions of this service:",
        `#   ${base}/llms.txt`,
        `#   ${base}/openapi.json`,
        `#   ${base}/mcp        (Model Context Protocol, streamable HTTP)`,
        `#   ${base}/probe      (free — coverage, freshness and pricing)`,
        "",
        "User-agent: *",
        "Allow: /",
        "",
        `Sitemap: ${base}/sitemap.xml`,
        "",
      ].join("\n"),
      200,
      { "cache-control": "public, max-age=86400" },
    ),
  );

  // Tiny sitemap covering only the free, crawlable surfaces. Paid endpoints are
  // deliberately excluded: a crawler cannot pay, so listing them would only
  // generate 402s and make the service look broken to whatever indexes it.
  router.get("/sitemap.xml", (c) =>
    c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        ["/", "/llms.txt", "/openapi.json", "/probe"]
          .map((p) => `  <url><loc>${base}${p}</loc></url>`)
          .join("\n") +
        `\n</urlset>\n`,
      200,
      { "content-type": "application/xml", "cache-control": "public, max-age=86400" },
    ),
  );

  return router;
}
