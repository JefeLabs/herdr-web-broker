import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError } from "./errors.js";

export interface OwnerBinding {
  email: string;
  session: string;
  token: string;
  created_at: string;
}

/** One email owns one herdr session (spec 2026-08-22). Bindings are
 * sticky — the first token to identify as an email owns it — and persisted
 * so ownership survives broker restarts. Names are deterministic
 * `u-<slug>-<hash>`: the same email re-provisions into the same session
 * name after a teardown, and the `u-` namespace structurally can never
 * collide with the primary `default` session (the API-plugin invariant). */
export class OwnerRegistry {
  #path: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.#path = join(stateDir, "owners.json");
  }

  #read(): Record<string, OwnerBinding> {
    try {
      return JSON.parse(readFileSync(this.#path, "utf8")) as Record<string, OwnerBinding>;
    } catch {
      return {};
    }
  }

  #write(data: Record<string, OwnerBinding>): void {
    writeFileSync(this.#path, JSON.stringify(data, null, 2) + "\n");
  }

  static sessionNameFor(email: string): string {
    const normalized = email.trim().toLowerCase();
    const slug = normalized
      .split("@")[0]
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 16) || "user";
    const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 6);
    return `u-${slug}-${hash}`;
  }

  /** Sticky bind: unbound email → new binding; same token → the existing
   * one; a different token → email_taken (admin rebind is the escape). */
  bind(email: string, token: string): OwnerBinding & { created: boolean } {
    const key = email.trim().toLowerCase();
    const data = this.#read();
    const existing = data[key];
    if (existing) {
      if (existing.token !== token) {
        throw new BrokerError("email_taken", `'${key}' is bound to another token — ask an admin to rebind`);
      }
      return { ...existing, created: false };
    }
    const binding: OwnerBinding = {
      email: key,
      session: OwnerRegistry.sessionNameFor(key),
      token,
      created_at: new Date().toISOString(),
    };
    data[key] = binding;
    this.#write(data);
    return { ...binding, created: true };
  }

  byEmail(email: string): OwnerBinding | undefined {
    return this.#read()[email.trim().toLowerCase()];
  }

  bySession(session: string): OwnerBinding | undefined {
    return Object.values(this.#read()).find((b) => b.session === session);
  }

  byToken(token: string): OwnerBinding | undefined {
    return Object.values(this.#read()).find((b) => b.token === token);
  }

  list(): OwnerBinding[] {
    return Object.values(this.#read()).sort((a, b) => a.email.localeCompare(b.email));
  }

  /** Admin escape hatch: move an email's binding to a new token (new
   * device, lost token). The session and its agents are untouched. */
  rebind(email: string, token: string): OwnerBinding {
    const key = email.trim().toLowerCase();
    const data = this.#read();
    const existing = data[key];
    if (!existing) throw new BrokerError("unknown_email", `no binding for '${key}'`);
    existing.token = token;
    this.#write(data);
    return existing;
  }

  remove(email: string): void {
    const data = this.#read();
    delete data[email.trim().toLowerCase()];
    this.#write(data);
  }
}
