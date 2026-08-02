import type { SettleContext, SettleResultContext } from "@x402/core/server";
import type { IdempotencyStore } from "./idempotency";

// Composes the seller-side replay/binding/expiry controls into the x402 v2
// verify→settle flow as a resource-server extension (handoff §5.2). Hooks fire only
// for routes that declare GUARD_EXTENSION_KEY.
//
//   onBeforeSettle  — reject before settling: proof outside its validity window, or
//                     the payment id already bound to a DIFFERENT resource
//                     (cross-resource replay, arXiv:2605.11781 Attack II).
//   onAfterSettle   — record the (payment id → resource) binding ONLY after a
//                     successful settlement, so a failed settle leaves no claim.
//
// The binding key is the x402-native `requirements.resource`; the payment id is the
// EIP-3009 nonce from the signed authorization.

export const GUARD_EXTENSION_KEY = "agentfilings_replay_guard";

const CLOCK_SKEW_SEC = 60;
const CLAIM_TTL_MS = 10 * 60 * 1000;

export interface GuardProof {
  payId: string;
  validAfter: number;
  validBefore: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pull the EIP-3009 authorization (nonce + validity window) out of a PaymentPayload. */
export function extractProofFromPayload(payload: unknown): GuardProof | null {
  if (!isRecord(payload)) return null;
  const inner = payload["payload"];
  if (!isRecord(inner)) return null;
  const auth = inner["authorization"];
  if (!isRecord(auth)) return null;

  const nonce = auth["nonce"];
  const validAfter = Number(auth["validAfter"]);
  const validBefore = Number(auth["validBefore"]);
  if (typeof nonce !== "string" || !Number.isFinite(validAfter) || !Number.isFinite(validBefore)) {
    return null;
  }
  return { payId: nonce, validAfter, validBefore };
}

function resourceKey(requirements: unknown): string {
  if (isRecord(requirements) && typeof requirements["resource"] === "string") {
    return requirements["resource"];
  }
  return "";
}

/** Current wall-clock in unix seconds; injectable for tests. */
export type Clock = () => number;

const systemClock: Clock = () => Math.floor(Date.now() / 1000);

export function createPaymentGuardExtension(store: IdempotencyStore, clock: Clock = systemClock) {
  return {
    key: GUARD_EXTENSION_KEY,
    hooks: {
      onBeforeSettle: async (_declaration: unknown, context: SettleContext) => {
        const proof = extractProofFromPayload(context.paymentPayload);
        if (!proof) return; // malformed → let the facilitator's verify reject it

        const now = clock();
        if (now + CLOCK_SKEW_SEC < proof.validAfter || now - CLOCK_SKEW_SEC > proof.validBefore) {
          return { abort: true as const, reason: "payment proof is outside its validity window" };
        }

        const resource = resourceKey(context.requirements);
        const seen = await store.check(proof.payId, resource);
        if (seen === "conflict_other_resource") {
          return { abort: true as const, reason: "payment proof already used for a different resource" };
        }
        return;
      },
      onAfterSettle: async (_declaration: unknown, context: SettleResultContext) => {
        const proof = extractProofFromPayload(context.paymentPayload);
        if (!proof) return;
        await store.record(proof.payId, resourceKey(context.requirements), CLAIM_TTL_MS);
      },
    },
  };
}
