import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { createSubscriptionGate } from "./billing/gate";
import { InMemoryApiKeyStore, PostgresApiKeyStore, type ApiKeyStore } from "./billing/keys";
import { stripeEnabled } from "./billing/stripe";
import { loadEnv } from "./env";
import { TtlCache } from "./lib/cache";
import { fail } from "./lib/response";
import { createMcpPaidWrapper } from "./mcp/payments";
import { createMcpServer } from "./mcp/server";
import { createPaymentStack, x402Enabled } from "./payments/x402";
import { LocalJsonCorpusRepo, type CorpusRepo } from "./repo/corpus-repo";
import { PostgresCorpusRepo } from "./repo/postgres-repo";
import { billing } from "./routes/billing";
import { earningsSummary } from "./routes/earnings-summary";
import { filingsLatest } from "./routes/filings-latest";
import { health } from "./routes/health";
import { insiders } from "./routes/insiders";
import { llmsTxt } from "./routes/llms";
import { openapi } from "./routes/openapi";
import { probe } from "./routes/probe";
import { root } from "./routes/root";

export interface AppDeps {
  repo?: CorpusRepo;
  keys?: ApiKeyStore;
}

export function createApp(deps: AppDeps = {}): Hono {
  const env = loadEnv();
  const repo =
    deps.repo ??
    (env.DATABASE_URL
      ? new PostgresCorpusRepo(env.DATABASE_URL)
      : new LocalJsonCorpusRepo(process.env.CORPUS_DIR ?? "data/corpus"));
  const cache = new TtlCache();
  // Subscription keys live in Postgres in production. In dev/tests the in-memory
  // store keeps the gate exercisable without a database.
  const keys =
    deps.keys ??
    (env.DATABASE_URL ? new PostgresApiKeyStore(env.DATABASE_URL) : new InMemoryApiKeyStore());

  const app = new Hono();

  // Any uncaught throw still returns the machine-readable error envelope.
  app.onError((err, c) => {
    console.error("unhandled error:", err);
    return c.json(fail("internal", "Unexpected server error."), 500);
  });

  // Free routes. These sit BEFORE the payment middleware and are never gated:
  // discovery crawlers and agents must be able to read them without paying.
  const publicBase = env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`;
  app.route("/", root(publicBase));
  app.route("/openapi.json", openapi(env));
  app.route("/llms.txt", llmsTxt(publicBase));
  app.route("/health", health);
  app.route("/probe", probe(repo));

  // Billing is free and unauthenticated by necessity: a prospective buyer has no key
  // yet, and Stripe's webhook cannot present one.
  if (stripeEnabled(env)) {
    app.route("/billing", billing(env, keys, publicBase));
  }

  // Two payment rails on the same routes. x402 gates anonymous callers (enabled via
  // X402_ENABLED + a receiving address); a valid subscription key bypasses it. The
  // gate is installed even when x402 is off, so key auth and its 401s behave the same
  // in dev as in production.
  const paymentStack = x402Enabled(env) ? createPaymentStack(env) : null;
  app.use(createSubscriptionGate({ store: keys, x402: paymentStack?.middleware }));
  app.route("/filings/latest", filingsLatest(repo, cache));
  app.route("/earnings/summary", earningsSummary(repo, cache));
  app.route("/insiders", insiders(repo, cache));

  // MCP server over streamable HTTP (handoff §6). Stateless: a fresh server +
  // transport per request (the web-standard transport is single-use). Paid tools
  // share the same resource server + guard when x402 is enabled.
  const mcpPaidWrapper = paymentStack
    ? createMcpPaidWrapper(env, paymentStack.resourceServer)
    : undefined;
  app.all("/mcp", async (c) => {
    // A subscriber gets unwrapped tools: they have already paid this month, and
    // charging them per tool call as well would be billing twice for one thing.
    // The gate ahead of this has already authenticated (or rejected) the key.
    const server = createMcpServer(repo, c.get("subscriber") ? undefined : mcpPaidWrapper);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}

export const app = createApp();

export default app;
