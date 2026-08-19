import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type AgentStatus = "working" | "blocked" | "idle";

/** Same working|blocked|idle coercion applied on the wire — re-applied to
 * persisted data too, so a hand-tampered registry.json can't push an
 * unrecognized status into counts() and NaN the rollup. */
function coerceStatus(status: unknown): AgentStatus {
  return status === "working" || status === "blocked" ? status : "idle";
}

export interface AgentInfo {
  id: string;
  title: string;
  status: AgentStatus;
}

export interface SessionSnapshot {
  name: string;
  agents: AgentInfo[];
}

export interface InstanceSnapshot {
  platform: string;
  herdr_version: string;
  sessions: SessionSnapshot[];
}

export interface Counts {
  working: number;
  blocked: number;
  idle: number;
}

interface Stored {
  online: boolean;
  as_of: string;
  platform: string;
  herdr_version: string;
  sessions: Record<string, { agents: AgentInfo[] }>;
}

export class Registry extends EventEmitter {
  #instances = new Map<string, Stored>();

  constructor(readonly persistPath?: string) {
    super();
  }

  /** Boot from persisted stale data: everything comes back offline. */
  load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.persistPath, "utf8")) as Record<string, Stored>;
      for (const [name, entry] of Object.entries(data)) {
        const sessions = Object.fromEntries(
          Object.entries(entry.sessions ?? {}).map(([sessionName, sess]) => [
            sessionName,
            { agents: (sess.agents ?? []).map((a) => ({ ...a, status: coerceStatus(a.status) })) },
          ]),
        );
        this.#instances.set(name, { ...entry, sessions, online: false });
      }
    } catch {
      // Corrupt registry.json: start empty (broker-owned state self-heals)
    }
  }

  #flush(): void {
    if (!this.persistPath) return;
    writeFileSync(
      this.persistPath,
      JSON.stringify(Object.fromEntries(this.#instances), null, 2) + "\n",
    );
  }

  #touch(entry: Stored): void {
    entry.as_of = new Date().toISOString();
  }

  replaceSnapshot(instance: string, snap: InstanceSnapshot): void {
    const wasOnline = this.#instances.get(instance)?.online ?? false;
    const entry: Stored = {
      online: true,
      as_of: new Date().toISOString(),
      platform: snap.platform,
      herdr_version: snap.herdr_version,
      sessions: Object.fromEntries(snap.sessions.map((s) => [s.name, { agents: [...s.agents] }])),
    };
    this.#instances.set(instance, entry);
    this.#flush();
    if (!wasOnline) this.emit("online", { instance });
    this.emit("snapshot", { instance });
  }

  applyAgentStatus(instance: string, session: string, agent: AgentInfo): void {
    const entry = this.#instances.get(instance);
    if (!entry) return;
    const sess = (entry.sessions[session] ??= { agents: [] });
    const existing = sess.agents.findIndex((a) => a.id === agent.id);
    if (existing === -1) sess.agents.push(agent);
    else sess.agents[existing] = agent;
    this.#touch(entry);
    this.#flush();
    this.emit("agent_status", { instance, session, agent });
  }

  applySessionAdded(instance: string, session: SessionSnapshot): void {
    const entry = this.#instances.get(instance);
    if (!entry) return;
    entry.sessions[session.name] = { agents: [...session.agents] };
    this.#touch(entry);
    this.#flush();
    this.emit("session_added", { instance, session });
  }

  applySessionRemoved(instance: string, session: string): void {
    const entry = this.#instances.get(instance);
    if (!entry) return;
    delete entry.sessions[session];
    this.#touch(entry);
    this.#flush();
    this.emit("session_removed", { instance, session });
  }

  /** Keeps last-known sessions and as_of — stale beats silent (spec §5). */
  setOffline(instance: string): void {
    const entry = this.#instances.get(instance);
    if (!entry || !entry.online) return;
    entry.online = false;
    this.#flush();
    this.emit("offline", { instance });
  }

  get(instance: string): Stored | undefined {
    return this.#instances.get(instance);
  }

  instances(): string[] {
    return [...this.#instances.keys()];
  }

  counts(instance: string): Counts {
    const counts: Counts = { working: 0, blocked: 0, idle: 0 };
    const entry = this.#instances.get(instance);
    if (!entry) return counts;
    for (const sess of Object.values(entry.sessions)) {
      for (const agent of sess.agents) counts[agent.status] += 1;
    }
    return counts;
  }

  rollup(): { instance: string; online: boolean; as_of: string; counts: Counts }[] {
    return this.instances().map((instance) => {
      const entry = this.#instances.get(instance)!;
      return { instance, online: entry.online, as_of: entry.as_of, counts: this.counts(instance) };
    });
  }
}
