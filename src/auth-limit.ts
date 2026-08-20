/** Sliding-window failed-auth limiter, keyed by remote address. Brute
 * force against the bearer surface stops mattering once an address gets
 * `429 rate_limited` after too many misses; any successful auth clears
 * that address. In-memory by design — a restart forgiving script kiddies
 * is an acceptable trade for zero persistence machinery. */
export interface AuthLimiterOpts {
  maxFailures?: number;
  windowMs?: number;
  /** test clock */
  now?: () => number;
}

export class AuthLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #failures = new Map<string, number[]>();

  constructor(opts: AuthLimiterOpts = {}) {
    this.#max = opts.maxFailures ?? 10;
    this.#windowMs = opts.windowMs ?? 60_000;
    this.#now = opts.now ?? Date.now;
  }

  #live(ip: string): number[] {
    const cutoff = this.#now() - this.#windowMs;
    const kept = (this.#failures.get(ip) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.#failures.delete(ip);
    else this.#failures.set(ip, kept);
    return kept;
  }

  record(ip: string): void {
    this.#failures.set(ip, [...this.#live(ip), this.#now()]);
  }

  success(ip: string): void {
    this.#failures.delete(ip);
  }

  blocked(ip: string): boolean {
    return this.#live(ip).length >= this.#max;
  }
}
