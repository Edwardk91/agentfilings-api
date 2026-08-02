import {
  HTTPFacilitatorClient,
  type RouteConfig,
  type RoutesConfig,
  x402ResourceServer,
} from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/hono";
import {
  payableEndpoints,
  USDC_CONTRACT,
  USDC_EIP712_DOMAIN,
  usdToAtomicUsdc,
  X402_FACILITATORS,
  X402_NETWORKS,
  X402_SCHEME,
  type X402Network,
} from "@agentfilings/shared";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { DISCOVERY_BY_ENDPOINT, SERVICE_NAME, SERVICE_TAGS } from "./discovery";
import { InMemoryIdempotencyStore, type IdempotencyStore } from "./idempotency";
import { createPaymentGuardExtension, GUARD_EXTENSION_KEY } from "./x402-guard";

// x402 v2 wiring against the real @x402/* 2.19.0 API, verified against the
// installed type declarations rather than the docs. Gated OFF by default (X402_ENABLED) so
// paid routes stay open in dev until a receiving address + a live Base Sepolia
// settlement test exist. The seller-side security controls (binding/replay/expiry)
// live in ./guard and compose with the facilitator verify+settle this wires up.

function assertKnownNetwork(network: string): X402Network {
  if (network === "eip155:8453" || network === "eip155:84532") return network;
  throw new Error(
    `Unsupported X402_NETWORK "${network}". Use eip155:8453 (Base mainnet) or eip155:84532 (Base Sepolia).`,
  );
}

/** Whether to gate paid routes behind x402. Off unless explicitly enabled AND a
 * receiving address is configured. */
export function x402Enabled(env: Env): boolean {
  return process.env.X402_ENABLED === "true" && Boolean(env.X402_RECEIVING_ADDRESS);
}

/** Build the x402 routes config from the shared pricing table. Prices use the
 * AssetAmount form (bare USDC address + atomic-units string) — the Bazaar indexer
 * requires this, not just the "$0.01" shorthand (research finding). */
export function buildRoutesConfig(env: Env): RoutesConfig {
  const network = assertKnownNetwork(env.X402_NETWORK);
  const payTo = env.X402_RECEIVING_ADDRESS;
  if (!payTo) {
    throw new Error("X402_RECEIVING_ADDRESS is required to enable x402.");
  }
  const asset = USDC_CONTRACT[network];

  // Behind Railway's proxy TLS terminates upstream, so the app sees plain HTTP and
  // the challenge would advertise an http:// resource URL for an https-only service.
  // Discovery crawlers and agents key off this URL, so pin it explicitly.
  const publicBase = env.PUBLIC_BASE_URL?.replace(/\/$/, "");

  // ONLY implemented endpoints may be payment-gated. A planned-but-unmounted route
  // would otherwise issue a valid 402, collect payment, and then 404 — charging for
  // something that cannot be served.
  const routes: Record<string, RouteConfig> = {};
  for (const ep of payableEndpoints()) {
    // `accepts` is checked structurally against x402's PaymentOption via RouteConfig.
    routes[`${ep.method} ${ep.path}`] = {
      ...(publicBase ? { resource: `${publicBase}${ep.path}` } : {}),
      accepts: {
        scheme: X402_SCHEME, // "exact"
        network: network as Network,
        payTo,
        // Explicit asset + atomic amount (Bazaar indexer requires both), plus the
        // token's EIP-712 domain so the paying client can sign the authorization.
        price: { asset, amount: usdToAtomicUsdc(ep.priceUsd), extra: USDC_EIP712_DOMAIN[network] },
        maxTimeoutSeconds: 60,
      },
      description: ep.summary,
      mimeType: "application/json",
      // Service metadata shown in discovery catalogs.
      serviceName: SERVICE_NAME,
      tags: SERVICE_TAGS,
      extensions: {
        // Replay-guard: makes its settle hooks fire for this route.
        [GUARD_EXTENSION_KEY]: {},
        // Bazaar discovery: input schema + example output so a catalog can show how to
        // call this endpoint and what comes back, instead of just a URL and a price.
        ...(DISCOVERY_BY_ENDPOINT[ep.id] ?? {}),
      },
    };
  }
  return routes;
}

/** Whether the configured facilitator is CDP's (which requires JWT auth). */
function usesCdpFacilitator(env: Env): boolean {
  return (env.X402_FACILITATOR_URL ?? "").includes("cdp.coinbase.com");
}

export function createFacilitatorClient(env: Env): HTTPFacilitatorClient {
  // Selection is driven by the FACILITATOR URL, not by whether credentials happen to
  // be present. Credentials may be staged in the environment well before the switch,
  // and silently rerouting live traffic to a different facilitator the moment a
  // variable appears would be a surprising, hard-to-debug change.
  if (usesCdpFacilitator(env)) {
    // CDP rejects unauthenticated verify/settle, so refuse to start rather than fail
    // every payment at runtime.
    if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) {
      throw new Error(
        "The CDP facilitator requires CDP_API_KEY_ID and CDP_API_KEY_SECRET. " +
          "The secret must be the key material CDP issued (PEM EC or base64 Ed25519).",
      );
    }
    return createCdpFacilitatorClient({
      apiKeyId: env.CDP_API_KEY_ID,
      apiKeySecret: env.CDP_API_KEY_SECRET,
      baseUrl: env.X402_FACILITATOR_URL,
    });
  }

  if (env.X402_NETWORK === X402_NETWORKS.baseMainnet) {
    throw new Error(
      `Base mainnet requires the CDP facilitator (${X402_FACILITATORS.cdpMainnet}); ` +
        `${env.X402_FACILITATOR_URL ?? "(unset)"} is testnet-only.`,
    );
  }

  return new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL });
}

export function createResourceServer(env: Env, store: IdempotencyStore): x402ResourceServer {
  const network = assertKnownNetwork(env.X402_NETWORK);
  const server = new x402ResourceServer(createFacilitatorClient(env)).register(
    network as Network,
    new ExactEvmScheme(),
  );
  // Compose the seller-side replay/binding/expiry controls into verify→settle.
  server.registerExtension(createPaymentGuardExtension(store));
  // Bazaar discovery: enriches the payment-required response and settlement so the
  // catalog can index this resource. Without it the routes' discovery declarations
  // are inert.
  server.registerExtension(bazaarResourceServerExtension);
  return server;
}

export interface PaymentStack {
  store: IdempotencyStore;
  resourceServer: x402ResourceServer;
  middleware: MiddlewareHandler;
}

/** Build the shared payment stack: one idempotency store + resource server (with the
 * guard extension) reused by both the HTTP middleware and the MCP paid-tool wrapper. */
export function createPaymentStack(env: Env): PaymentStack {
  const store = new InMemoryIdempotencyStore();
  const resourceServer = createResourceServer(env, store);
  // syncFacilitatorOnStart MUST stay true here: it fetches the facilitator's supported
  // (scheme, network) kinds. Without it, building payment requirements throws
  // "Facilitator does not support exact on <network>" and paid routes 500 instead of
  // issuing the 402 challenge. (Disabling it is only an option for serverless cold
  // starts, where you must call initialize() yourself — we are a long-running service.)
  const middleware = paymentMiddleware(buildRoutesConfig(env), resourceServer);
  return { store, resourceServer, middleware };
}
