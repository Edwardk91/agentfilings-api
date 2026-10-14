import postgres, { type Sql } from "postgres";

/** postgres.js options, taken from the constructor so it tracks the library's type. */
type SqlOptions = NonNullable<Parameters<typeof postgres>[1]>;

// Postgres connection factory, shared by the corpus repo and the API-key store.
//
// Everything here exists because of one property of Supabase's transaction pooler
// (pgbouncer, port 6543): it closes idle client connections server-side, without
// telling the client. postgres.js keeps the dead socket in its pool, and the next
// query writes to it and throws `write CONNECTION_CLOSED`.
//
// This bites hardest on the LOWEST-traffic endpoints. A busy route keeps its
// connections warm; /probe and / can sit idle for an hour between visitors, which
// is exactly long enough for the pooler to hang up. Observed in production as
// intermittent 500s from getCoverage, ~67 minutes apart.
//
// Two defences, because either alone leaves a race:
//   1. Close connections ourselves before the pooler does (idle_timeout).
//   2. Retry once on a connection-level failure, since a socket can still die
//      between our check and our write.

/** Seconds a pooled connection may sit unused before we close it ourselves. */
const IDLE_TIMEOUT_SEC = 20;
/** Recycle connections on this cadence regardless of use. */
const MAX_LIFETIME_SEC = 60 * 30;

export function createSql(connectionString: string, overrides: SqlOptions = {}): Sql {
  return postgres(connectionString, {
    // The transaction pooler does not support prepared statements.
    prepare: false,
    // Close before the pooler does. This is the primary fix.
    idle_timeout: IDLE_TIMEOUT_SEC,
    max_lifetime: MAX_LIFETIME_SEC,
    connect_timeout: 10,
    // The pooler enforces its own client limit; a small pool is plenty for this
    // workload and leaves headroom for the ingest job running concurrently.
    max: 5,
    ...overrides,
  });
}

/** Connection-level failures, as distinct from query errors. Only these are retried. */
const RETRYABLE = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECTION_CONNECT_TIMEOUT",
  "ECONNRESET",
  "EPIPE",
]);

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === "string" && RETRYABLE.has(code);
}

/**
 * Run a query, retrying once if the connection died underneath it.
 *
 * Deliberately narrow: only connection-level codes retry, and only once. A query
 * that fails because the SQL is wrong, or the data is bad, must surface
 * immediately rather than being run twice. Every caller here is a read, so the
 * retry is safe; do not wrap writes with this without checking idempotency.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRetryable(err)) throw err;
    // postgres.js opens a fresh connection for the next query, so the retry runs
    // on a live socket. One attempt only — if that also fails, the pooler or the
    // database is genuinely unavailable and the caller should see it.
    console.warn(`db: retrying after ${(err as { code?: string }).code}`);
    return fn();
  }
}
