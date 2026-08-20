import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Append-only JSONL trail of privileged actions — who kicked, minted,
 * revoked, or rewrote credentials, from where, when. A flat file in the
 * state dir on purpose: it survives the process, greps cleanly, and has
 * no delete/update surface an attacker could tidy up after themselves
 * with. Malformed lines are skipped on read, never fatal. */
export interface AuditEntry {
  ts: string;
  action: string;
  actor: string;
  target?: string;
  remote?: string;
}

export class Audit {
  constructor(private readonly path: string) {}

  record(e: Omit<AuditEntry, "ts">): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`, { mode: 0o600 });
  }

  /** The last `limit` entries, oldest first. */
  tail(limit = 100): AuditEntry[] {
    if (!existsSync(this.path)) return [];
    const entries: AuditEntry[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // a corrupt line must never make history unreadable
      }
    }
    return entries.slice(-limit);
  }
}
