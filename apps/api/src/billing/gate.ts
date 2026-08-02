import type { MiddlewareHandler } from "hono";
import { fail } from "../lib/response";
import {
  extractApiKey,
  hashKey,
  looksLikeApiKey,
  type ApiKeyRecord,
  type ApiKeyStore,
} from "./keys";

// The two payment rails, composed.
//
// Order matters and the failure modes are deliberate:
//
//   no credential          -> fall through to x402 (unchanged behaviour)
//   valid active key       -> serve, skip x402 entirely
//   malformed/unknown/dead -> 401, and NEVER fall through to x402
//
// That last case is the one worth being careful about. Falling through would answer
// a subscriber's expired key with a 402 payment challenge, which reads as "pay again"
// rather than "your subscription lapsed" — and an agent holding a wallet might simply
// pay it. Answering 401 with the real reason costs us nothing and cannot double-charge
// somebody who already believes they are paying us monthly.

declare module "hono" {
  interface ContextVariableMap {
    subscriber?: ApiKeyRecord;
  }
}

export interface SubscriptionGateOptions {
  store: ApiKeyStore;
  /** The x402 middleware, when that rail is enabled. Absent = open routes in dev. */
  x402?: MiddlewareHandler;
}

export function createSubscriptionGate({ store, x402 }: SubscriptionGateOptions): MiddlewareHandler {
  return async (c, next) => {
    const presented = extractApiKey({
      authorization: c.req.header("authorization"),
      apiKey: c.req.header("x-api-key"),
    });

    // No credential offered: this is an anonymous caller, which is exactly who x402
    // exists for. Behaviour here is identical to before the subscription rail.
    if (!presented) {
      return x402 ? x402(c, next) : next();
    }

    if (!looksLikeApiKey(presented)) {
      return c.json(
        fail(
          "unauthorized",
          "The supplied API key is not a valid AgentFilings key.",
          "Keys look like af_live_… . Subscribe at /billing/subscribe, or omit the " +
            "header entirely to pay per call with x402.",
        ),
        401,
      );
    }

    const record = await store.findActiveByHash(hashKey(presented));
    if (!record) {
      return c.json(
        fail(
          "unauthorized",
          "This API key is unknown, revoked, or its subscription is no longer active.",
          "Check the key, or resubscribe at /billing/subscribe. Omit the header to " +
            "pay per call with x402 instead.",
        ),
        401,
      );
    }

    c.set("subscriber", record);
    // Telemetry only — deliberately not awaited so a slow write cannot add latency
    // to a request the subscriber has already paid for.
    void store.recordUse(record.id);
    return next();
  };
}
