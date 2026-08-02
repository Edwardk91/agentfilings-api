import { describe, expect, it } from "vitest";
import { ENDPOINTS, USDC_CONTRACT } from "@agentfilings/shared";
import type { Env } from "../env";
import { GUARD_EXTENSION_KEY } from "./x402-guard";
import { buildRoutesConfig, createFacilitatorClient, createPaymentStack, x402Enabled } from "./x402";

function testnetEnv(overrides: Partial<Env> = {}): Env {
  return {
    PORT: 8080,
    X402_NETWORK: "eip155:84532",
    X402_FACILITATOR_URL: "https://x402.org/facilitator",
    X402_RECEIVING_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    ...overrides,
  };
}

// Minimal structural view of the route config for assertions (PaymentOption is not
// publicly exported by @x402).
interface Accepts {
  scheme: string;
  network: string;
  payTo: string;
  price: { asset: string; amount: string; extra?: { name: string; version: string } };
}
type Routes = Record<
  string,
  {
    accepts: Accepts;
    description?: string;
    mimeType?: string;
    resource?: string;
    serviceName?: string;
    tags?: string[];
    extensions?: Record<string, unknown>;
  }
>;

describe("buildRoutesConfig", () => {
  it("emits Bazaar-compliant atomic USDC amounts + bare asset per paid route", () => {
    const routes = buildRoutesConfig(testnetEnv()) as Routes;

    const filings = routes["GET /filings/latest"];
    expect(filings).toBeTruthy();
    expect(filings!.accepts.scheme).toBe("exact");
    expect(filings!.accepts.network).toBe("eip155:84532");
    expect(filings!.accepts.price.amount).toBe("10000"); // $0.01 → 10000 atomic (6dp)
    expect(filings!.accepts.price.asset).toBe(USDC_CONTRACT["eip155:84532"]);

    expect(routes["GET /earnings/summary"]!.accepts.price.amount).toBe("20000"); // $0.02

    // Every paid route declares the replay-guard extension so its settle hooks fire.
    expect(filings!.extensions).toHaveProperty(GUARD_EXTENSION_KEY);
  });

  it("includes the token's EIP-712 domain so paying clients can sign", () => {
    // Without `extra`, clients fail with "EIP-712 domain parameters (name, version)
    // are required". The name differs per network — mainnet USDC is "USD Coin".
    const sepolia = buildRoutesConfig(testnetEnv()) as Routes;
    expect(sepolia["GET /filings/latest"]!.accepts.price.extra).toEqual({
      name: "USDC",
      version: "2",
    });

    const mainnet = buildRoutesConfig(testnetEnv({ X402_NETWORK: "eip155:8453" })) as Routes;
    expect(mainnet["GET /filings/latest"]!.accepts.price.extra).toEqual({
      name: "USD Coin",
      version: "2",
    });
  });

  it("advertises an absolute HTTPS resource URL when PUBLIC_BASE_URL is set", () => {
    // Behind a TLS-terminating proxy the request looks like plain HTTP, which would
    // publish an http:// resource URL to discovery crawlers. PUBLIC_BASE_URL pins it.
    const routes = buildRoutesConfig(
      testnetEnv({ PUBLIC_BASE_URL: "https://api.agentfilings.com/" }),
    ) as Routes;
    expect(routes["GET /earnings/summary"]!.resource).toBe(
      "https://api.agentfilings.com/earnings/summary",
    );
    // Unset => fall back to the middleware's request-derived URL.
    const bare = buildRoutesConfig(testnetEnv()) as Routes;
    expect(bare["GET /earnings/summary"]!.resource).toBeUndefined();
  });

  it("NEVER payment-gates an endpoint that is not implemented", () => {
    // A route with no handler would issue a valid 402, take the money, then 404.
    // Only endpoints marked available may appear in the payment config.
    const routes = buildRoutesConfig(testnetEnv()) as Routes;
    const gated = Object.keys(routes);

    for (const ep of ENDPOINTS.filter((e) => !e.available)) {
      expect(gated).not.toContain(`${ep.method} ${ep.path}`);
    }
    // ...and every implemented paid endpoint IS gated.
    for (const ep of ENDPOINTS.filter((e) => e.available && e.priceUsd > 0)) {
      expect(gated).toContain(`${ep.method} ${ep.path}`);
    }
    expect(gated).toContain("GET /insiders");
    expect(gated).not.toContain("GET /institutional");
  });

  it("declares Bazaar discovery with the type discriminators the indexer requires", () => {
    // A resource can settle payments and still never appear in the catalog if the
    // discovery declaration is missing or lacks input.type / output.type. Every paid
    // route must carry a bazaar extension alongside the replay guard.
    const routes = buildRoutesConfig(testnetEnv()) as Routes;

    for (const key of Object.keys(routes)) {
      const ext = routes[key]!.extensions as Record<string, { info?: Record<string, never> }>;
      expect(Object.keys(ext)).toContain("bazaar");

      const info = ext.bazaar!.info as unknown as {
        input?: { type?: string };
        output?: { type?: string; example?: unknown };
      };
      expect(info.input?.type).toBe("http");
      expect(info.output?.type).toBe("json");
      expect(info.output?.example).toBeTruthy();
    }

    // Service metadata is what a catalog actually displays.
    expect(routes["GET /filings/latest"]!.serviceName).toBe("AgentFilings");
    expect(routes["GET /filings/latest"]!.tags).toContain("sec");
  });

  it("throws without a receiving address", () => {
    expect(() => buildRoutesConfig(testnetEnv({ X402_RECEIVING_ADDRESS: undefined }))).toThrow();
  });

  it("throws on an unsupported network", () => {
    expect(() => buildRoutesConfig(testnetEnv({ X402_NETWORK: "eip155:1" }))).toThrow();
  });
});

describe("createFacilitatorClient", () => {
  const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

  it("does NOT switch to CDP just because credentials exist", () => {
    // Credentials are often staged in the environment before the cutover. Rerouting
    // live traffic the moment a variable appears would be a surprising change.
    const client = createFacilitatorClient(
      testnetEnv({ CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "secret" }),
    );
    expect(client.url).toContain("x402.org");
  });

  it("uses the CDP-authenticated client when the CDP facilitator is configured", () => {
    const client = createFacilitatorClient(
      testnetEnv({
        X402_NETWORK: "eip155:8453",
        X402_FACILITATOR_URL: CDP_URL,
        CDP_API_KEY_ID: "test-key-id",
        CDP_API_KEY_SECRET: "test-key-secret",
      }),
    );
    expect(client.url).toContain("cdp.coinbase.com");
  });

  it("refuses to start on the CDP facilitator without credentials", () => {
    // Better to fail the deploy than to 401 on every payment in production.
    expect(() =>
      createFacilitatorClient(testnetEnv({ X402_FACILITATOR_URL: CDP_URL })),
    ).toThrow(/CDP_API_KEY_ID/);
  });

  it("refuses Base mainnet pointed at a testnet-only facilitator", () => {
    expect(() =>
      createFacilitatorClient(testnetEnv({ X402_NETWORK: "eip155:8453" })),
    ).toThrow(/mainnet requires the CDP facilitator/i);
  });
});

describe("x402Enabled", () => {
  it("is off unless X402_ENABLED=true even with an address set", () => {
    expect(x402Enabled(testnetEnv())).toBe(false);
  });
});

describe("createPaymentStack", () => {
  it("constructs the store + resource server (with guard extension) + middleware", () => {
    const stack = createPaymentStack(testnetEnv());
    expect(stack.store).toBeTruthy();
    expect(stack.resourceServer).toBeTruthy();
    expect(typeof stack.middleware).toBe("function");
  });
});
