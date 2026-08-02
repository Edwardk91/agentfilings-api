// Minimal in-process TTL cache so the `meta.cache: hit|miss` contract is real in
// dev. Swapped for Upstash Redis once provisioned (handoff §5: cache full JSON
// keyed by endpoint+params; generous TTLs, bust on new-filing ingest).

interface Entry {
  value: unknown;
  expires: number;
}

export class TtlCache {
  private store = new Map<string, Entry>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }
}

export const TTL = {
  latestFilings: 15 * 60 * 1000, // 15 min
  earnings: 24 * 60 * 60 * 1000, // 24 h
  insiders: 15 * 60 * 1000, // 15 min (updates on new Form 4)
} as const;
