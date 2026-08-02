import { createHash } from "node:crypto";

// Resource binding (handoff §5.2 item 2). x402/EIP-3009 commits a payment only to
// (from, to, value, validAfter, validBefore, nonce) — NOT to the HTTP method/path/
// body. So a valid payment for a cheap route could be replayed against an expensive
// one. We bind each payment to a canonical resource id and reject mismatches.

export interface RequestContext {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  /** sha256 hex of the raw request body, or undefined when there is no body. */
  bodyHash?: string;
}

/** Deterministic query serialization: keys sorted, multi-values sorted. */
export function canonicalizeQuery(query: Record<string, string | string[]>): string {
  const parts: string[] = [];
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    const values = Array.isArray(value) ? [...value].sort() : [value];
    for (const v of values) parts.push(`${key}=${v}`);
  }
  return parts.join("&");
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Canonical id an accepted payment is bound to: H(method | path | query | bodyHash). */
export function resourceId(ctx: RequestContext): string {
  const canonical = [
    ctx.method.toUpperCase(),
    ctx.path,
    canonicalizeQuery(ctx.query),
    ctx.bodyHash ?? "",
  ].join("\n");
  return sha256Hex(canonical);
}
