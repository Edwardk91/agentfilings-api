// Per-key fixed-window rate limiting (handoff §5.2 item 6: per-IP and per-wallet
// limits). In-memory for dev; production uses Redis INCR with an expiring window.

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();

  /** Returns true if the call is allowed, false if the key exceeded `limit` in the window. */
  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (w.count >= limit) return false;
    w.count += 1;
    return true;
  }
}
