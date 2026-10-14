import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Sql } from "postgres";
import { createSql, withRetry } from "../lib/db";

// API key issuance and lookup for the subscription rail.
//
// The security posture, stated once: the raw key exists in memory exactly long
// enough to hand it to the buyer on the checkout success page, and is never written
// anywhere. We persist sha256(key) and a short non-secret prefix. A leaked database
// therefore yields no usable credentials, and "email me my key" is unanswerable by
// construction — the buyer rotates instead.
//
// A key is 32 bytes of CSPRNG output, so guessing is not a threat model and the
// hash lookup needs no salt or work factor: there is no low-entropy secret to
// protect and per-request KDF cost would be a self-inflicted DoS.

const KEY_BYTES = 32;
const LIVE_PREFIX = "af_live_";
/** Length of the non-secret display prefix beyond `af_live_`. */
const PREFIX_CHARS = 6;

export type KeyStatus = "active" | "past_due" | "canceled";

export interface ApiKeyRecord {
  id: number;
  keyPrefix: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  email: string | null;
  status: KeyStatus;
  createdAt: string;
}

export interface NewApiKey {
  keyHash: string;
  keyPrefix: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  email?: string | null;
}

export interface GeneratedKey {
  /** Shown to the buyer once, then discarded. Never persist this. */
  raw: string;
  keyHash: string;
  keyPrefix: string;
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function generateApiKey(): GeneratedKey {
  // base64url: no padding, URL-safe, and copy-pastes cleanly out of a terminal.
  const secret = randomBytes(KEY_BYTES).toString("base64url");
  const raw = `${LIVE_PREFIX}${secret}`;
  return {
    raw,
    keyHash: hashKey(raw),
    keyPrefix: `${LIVE_PREFIX}${secret.slice(0, PREFIX_CHARS)}`,
  };
}

/**
 * Pull the credential off a request.
 *
 * Accepts `Authorization: Bearer <key>` (what most SDKs send by default) and
 * `x-api-key` (what most agent frameworks send). Supporting both costs nothing and
 * removes an entire category of "why is it 401ing" support that we have no support
 * channel to absorb.
 */
export function extractApiKey(headers: {
  authorization?: string | null;
  apiKey?: string | null;
}): string | null {
  const direct = headers.apiKey?.trim();
  if (direct) return direct;
  const auth = headers.authorization?.trim();
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match?.[1]?.trim() || null;
}

/** Whether a string is even shaped like one of our keys — cheap pre-filter. */
export function looksLikeApiKey(candidate: string): boolean {
  return candidate.startsWith(LIVE_PREFIX) && candidate.length > LIVE_PREFIX.length + 20;
}

export interface ApiKeyStore {
  findActiveByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  insert(key: NewApiKey): Promise<ApiKeyRecord>;
  setStatusBySubscription(stripeSubscriptionId: string, status: KeyStatus): Promise<number>;
  /** Fire-and-forget usage stamp; must never block or fail a request. */
  recordUse(id: number): Promise<void>;
}

/** Constant-time compare of two hex digests of equal length. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly rows: (ApiKeyRecord & { keyHash: string })[] = [];
  private nextId = 1;

  async findActiveByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const row = this.rows.find((r) => hashesEqual(r.keyHash, keyHash) && r.status === "active");
    return row ? { ...row } : null;
  }

  async insert(key: NewApiKey): Promise<ApiKeyRecord> {
    const record: ApiKeyRecord & { keyHash: string } = {
      id: this.nextId++,
      keyHash: key.keyHash,
      keyPrefix: key.keyPrefix,
      stripeCustomerId: key.stripeCustomerId ?? null,
      stripeSubscriptionId: key.stripeSubscriptionId ?? null,
      email: key.email ?? null,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    this.rows.push(record);
    return { ...record };
  }

  async setStatusBySubscription(stripeSubscriptionId: string, status: KeyStatus): Promise<number> {
    let n = 0;
    for (const row of this.rows) {
      if (row.stripeSubscriptionId === stripeSubscriptionId) {
        row.status = status;
        n++;
      }
    }
    return n;
  }

  async recordUse(): Promise<void> {
    /* no-op in tests */
  }
}

export class PostgresApiKeyStore implements ApiKeyStore {
  private readonly sql: Sql;

  constructor(connectionString: string) {
    // Pooler quirks handled centrally — see lib/db.ts.
    this.sql = createSql(connectionString);
  }

  async findActiveByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const rows = await withRetry(() => this.sql<
      {
        id: number;
        key_prefix: string;
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
        email: string | null;
        status: KeyStatus;
        created_at: string;
      }[]
    >`
      select id, key_prefix, stripe_customer_id, stripe_subscription_id, email,
             status, created_at::text
      from api_keys
      where key_hash = ${keyHash} and status = 'active' and revoked_at is null
      limit 1`);
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      keyPrefix: row.key_prefix,
      stripeCustomerId: row.stripe_customer_id,
      stripeSubscriptionId: row.stripe_subscription_id,
      email: row.email,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  async insert(key: NewApiKey): Promise<ApiKeyRecord> {
    const rows = await this.sql<{ id: number; created_at: string }[]>`
      insert into api_keys (key_hash, key_prefix, stripe_customer_id, stripe_subscription_id, email)
      values (${key.keyHash}, ${key.keyPrefix}, ${key.stripeCustomerId ?? null},
              ${key.stripeSubscriptionId ?? null}, ${key.email ?? null})
      returning id, created_at::text`;
    const row = rows[0];
    if (!row) throw new Error("api key insert returned no row");
    return {
      id: Number(row.id),
      keyPrefix: key.keyPrefix,
      stripeCustomerId: key.stripeCustomerId ?? null,
      stripeSubscriptionId: key.stripeSubscriptionId ?? null,
      email: key.email ?? null,
      status: "active",
      createdAt: row.created_at,
    };
  }

  async setStatusBySubscription(stripeSubscriptionId: string, status: KeyStatus): Promise<number> {
    const revoked = status === "canceled";
    const rows = await this.sql`
      update api_keys
      set status = ${status},
          revoked_at = ${revoked ? this.sql`now()` : this.sql`revoked_at`}
      where stripe_subscription_id = ${stripeSubscriptionId}
      returning id`;
    return rows.length;
  }

  async recordUse(id: number): Promise<void> {
    // Usage stamping is telemetry, not authorization. A failure here must never
    // turn a paid request into an error, so it is swallowed deliberately.
    try {
      await this.sql`
        update api_keys
        set last_used_at = now(), request_count = request_count + 1
        where id = ${id}`;
    } catch (err) {
      console.error("api key usage stamp failed:", err);
    }
  }
}
