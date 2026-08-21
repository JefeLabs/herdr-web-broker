/** Who is using this instance. Identity is opt-in: a client POSTs
 * /auth with an optional name/email, keyed by which client token it
 * presented; every later authed request from that token refreshes
 * last_seen. Silent entries expire so a closed laptop doesn't look like an
 * active user forever. In-memory by design — presence is a live signal,
 * not a record. */

export interface PresenceEntry {
  token: string;
  name?: string;
  email?: string;
  since: string;
  last_seen: string;
}

const DEFAULT_TTL_MS = 10 * 60_000;

export class Presence {
  #entries = new Map<string, PresenceEntry & { seenAt: number }>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  /** Merge semantics: provided fields update, omitted fields survive from
   * the previous identify — a name-only refresh doesn't erase the email.
   * `since` marks the first identify and never moves. */
  identify(token: string, id: { name?: string; email?: string }): PresenceEntry {
    const now = Date.now();
    const existing = this.#entries.get(token);
    const name = id.name ?? existing?.name;
    const email = id.email ?? existing?.email;
    const entry = {
      token,
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      since: existing?.since ?? new Date(now).toISOString(),
      last_seen: new Date(now).toISOString(),
      seenAt: now,
    };
    this.#entries.set(token, entry);
    const { seenAt: _seenAt, ...pub } = entry;
    return pub;
  }

  /** Refreshes an existing entry only — identity stays opt-in. */
  touch(token: string): void {
    const entry = this.#entries.get(token);
    if (!entry) return;
    entry.seenAt = Date.now();
    entry.last_seen = new Date(entry.seenAt).toISOString();
  }

  list(): PresenceEntry[] {
    const cutoff = Date.now() - this.ttlMs;
    const out: PresenceEntry[] = [];
    for (const [token, entry] of this.#entries) {
      if (entry.seenAt < cutoff) {
        this.#entries.delete(token);
        continue;
      }
      const { seenAt: _seenAt, ...pub } = entry;
      out.push(pub);
    }
    return out.sort((a, b) => a.token.localeCompare(b.token));
  }

  remove(token: string): void {
    this.#entries.delete(token);
  }
}
