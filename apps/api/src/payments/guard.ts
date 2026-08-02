import type { IdempotencyStore } from "./idempotency";
import { resourceId as computeResourceId, type RequestContext } from "./resource";

// PaymentGuard is the tested spec of the seller-side x402 controls (handoff §5.2)
// that the protocol/facilitator does NOT provide: proof expiry with clock-skew
// tolerance, server-side settlement verification before serving, resource binding,
// and atomic replay protection. In production these pieces compose with the x402
// middleware's own verify+settle (see payments/x402.ts); here they are exercised as
// one deterministic unit.

export interface PaymentProof {
  /** Unique payment identifier — the EIP-3009 nonce. */
  payId: string;
  /** Unix seconds; payment not valid before this. */
  validAfter: number;
  /** Unix seconds; payment not valid after this. */
  validBefore: number;
}

export type GuardDecision =
  | { ok: true; replay: boolean }
  | { ok: false; code: "payment_invalid" | "payment_replayed"; reason: string };

export interface GuardConfig {
  /** Accepted clock skew in seconds (handoff: ±60s). */
  clockSkewSec?: number;
  /** How long a claimed payment id is retained. */
  ttlMs?: number;
}

/** Verifies settlement server-side. In production this wraps the facilitator; in
 * tests it is a mock. Returning false must prevent serving. */
export type SettlementVerifier = (proof: PaymentProof, ctx: RequestContext) => Promise<boolean>;

const DEFAULT_SKEW_SEC = 60;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class PaymentGuard {
  constructor(
    private readonly store: IdempotencyStore,
    private readonly verify: SettlementVerifier,
    private readonly config: GuardConfig = {},
  ) {}

  async authorize(
    proof: PaymentProof,
    ctx: RequestContext,
    nowSec: number,
  ): Promise<GuardDecision> {
    const skew = this.config.clockSkewSec ?? DEFAULT_SKEW_SEC;

    // 1. Expiry window (handoff §5.2 item 4), tolerating clock skew both ways.
    if (nowSec + skew < proof.validAfter) {
      return { ok: false, code: "payment_invalid", reason: "payment not yet valid" };
    }
    if (nowSec - skew > proof.validBefore) {
      return { ok: false, code: "payment_invalid", reason: "payment proof expired" };
    }

    // 2. Server-side settlement verification before serving (items 1). Never trust
    //    client-presented proof alone.
    if (!(await this.verify(proof, ctx))) {
      return { ok: false, code: "payment_invalid", reason: "settlement not verified" };
    }

    // 3. Resource binding + replay (items 2, 3): check, then record on first use.
    const rid = computeResourceId(ctx);
    const seen = await this.store.check(proof.payId, rid);

    if (seen === "conflict_other_resource") {
      // Same payment presented against a different resource — cross-resource replay.
      return { ok: false, code: "payment_replayed", reason: "payment bound to a different resource" };
    }
    if (seen === "fresh") {
      await this.store.record(proof.payId, rid, this.config.ttlMs ?? DEFAULT_TTL_MS);
    }

    // fresh → serve; replay_same_resource → safe retry, serve the cached response.
    return { ok: true, replay: seen === "replay_same_resource" };
  }
}
