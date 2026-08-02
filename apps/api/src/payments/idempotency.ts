// Replay / idempotency (handoff §5.2 item 3). Split into a read-only `check` and a
// `record` that commits only AFTER successful settlement — so a payment that fails to
// settle never leaves a claim that would grant free access on retry.
//
// A payment id (EIP-3009 nonce) is bound to the resource it settled for. A later
// presentation of the same id against a DIFFERENT resource is cross-resource replay.
//
// InMemory is for dev/tests; production uses Redis (SETNX + GET) with the same
// interface. Async so the Redis implementation drops in unchanged.

export type CheckResult = "fresh" | "replay_same_resource" | "conflict_other_resource";

export interface IdempotencyStore {
  /** Read-only: has `payId` already been recorded, and for which resource? */
  check(payId: string, resourceId: string): Promise<CheckResult>;
  /** Commit `payId` bound to `resourceId`, retained for `ttlMs`. Call after settle. */
  record(payId: string, resourceId: string, ttlMs: number): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, { resourceId: string; expires: number }>();

  async check(payId: string, resourceId: string): Promise<CheckResult> {
    const existing = this.store.get(payId);
    if (!existing || Date.now() > existing.expires) return "fresh";
    return existing.resourceId === resourceId ? "replay_same_resource" : "conflict_other_resource";
  }

  async record(payId: string, resourceId: string, ttlMs: number): Promise<void> {
    this.store.set(payId, { resourceId, expires: Date.now() + ttlMs });
  }
}
