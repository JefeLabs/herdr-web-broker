import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintSecret } from "./auth.js";

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export class ChildrenStore {
  #path: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.#path = join(stateDir, "children.json");
  }

  #read(): Record<string, { secret_hash: string }> {
    return readJson(this.#path, {});
  }

  #write(data: Record<string, { secret_hash: string }>): void {
    writeFileSync(this.#path, JSON.stringify(data, null, 2) + "\n");
  }

  get(name: string): { secret_hash: string } | undefined {
    return this.#read()[name];
  }

  set(name: string, secretHash: string): void {
    const data = this.#read();
    data[name] = { secret_hash: secretHash };
    this.#write(data);
  }

  delete(name: string): boolean {
    const data = this.#read();
    if (!(name in data)) return false;
    delete data[name];
    this.#write(data);
    return true;
  }

  names(): string[] {
    return Object.keys(this.#read());
  }
}

export interface WorkspaceMeta {
  cwd: string;
  label?: string;
}

/** workspace_id → cwd memory per session, following the ChildrenStore
 * pattern: file-backed so daemon restarts don't forget which working set a
 * spawned team belongs to.
 *
 * Not a fallback despite the original spec §4 framing: herdr's workspace
 * records carry no cwd at all (verified against 0.8.2/protocol 20 — see
 * herdrWorkspaces), so this file is the ONLY place a workspace's cwd exists.
 * Losing a row here loses the directory for good, which is why both removal
 * sites read the cwd out before dropping one. */
export class WorkspaceIndex {
  #path: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.#path = join(stateDir, "workspaces.json");
  }

  #read(): Record<string, Record<string, WorkspaceMeta>> {
    return readJson(this.#path, {});
  }

  #write(data: Record<string, Record<string, WorkspaceMeta>>): void {
    writeFileSync(this.#path, JSON.stringify(data, null, 2) + "\n");
  }

  get(session: string, workspaceId: string): WorkspaceMeta | undefined {
    return this.#read()[session]?.[workspaceId];
  }

  set(session: string, workspaceId: string, meta: WorkspaceMeta): void {
    const data = this.#read();
    (data[session] ??= {})[workspaceId] = meta;
    this.#write(data);
  }

  all(session: string): Record<string, WorkspaceMeta> {
    return this.#read()[session] ?? {};
  }

  remove(session: string, workspaceId: string): void {
    const data = this.#read();
    if (data[session]?.[workspaceId] !== undefined) {
      delete data[session][workspaceId];
      this.#write(data);
    }
  }

  /** Every workspace row for a whole session — used when the session itself
   * (not just one of its workspaces) is torn down. The sibling of
   * AgentIndex.removeSession: teardown stops the herdr PROCESS, so rows for
   * workspaces herdr no longer lists die too. Without this a deterministic
   * re-provision inherits stale rows, and resolveCwd's index fallback can
   * hand a repo endpoint a path from a session that no longer exists. */
  removeSession(session: string): void {
    const data = this.#read();
    if (data[session] !== undefined) {
      delete data[session];
      this.#write(data);
    }
  }
}

export interface AgentMeta {
  /** the id pinned at launch (--session-id/--session), when the CLI has
   * such a flag; absent means the transcript must be discovered instead */
  sessionId?: string;
  kind: string;
  /** ms since epoch — bounds claim-by-recency for unpinnable CLIs */
  startedAt: number;
}

/** pane_id -> agent meta per session. WorkspaceIndex is workspace-scoped
 * and cannot hold this: a mode-B spawn puts several panes, each its own
 * agent with its own session id, inside ONE workspace. */
export class AgentIndex {
  #path: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.#path = join(stateDir, "agents.json");
  }

  #read(): Record<string, Record<string, AgentMeta>> {
    return readJson(this.#path, {});
  }

  #write(data: Record<string, Record<string, AgentMeta>>): void {
    writeFileSync(this.#path, JSON.stringify(data, null, 2) + "\n");
  }

  get(session: string, pane: string): AgentMeta | undefined {
    return this.#read()[session]?.[pane];
  }

  set(session: string, pane: string, meta: AgentMeta): void {
    const data = this.#read();
    (data[session] ??= {})[pane] = meta;
    this.#write(data);
  }

  /** Returns the row it removed, so a caller can archive the conversation
   * before the pane's record disappears (roadmap 31b: a transcript pointer
   * and a resumption handle have different lifetimes). */
  remove(session: string, pane: string): AgentMeta | undefined {
    const data = this.#read();
    const meta = data[session]?.[pane];
    if (meta !== undefined) {
      delete data[session][pane];
      this.#write(data);
    }
    return meta;
  }

  /** Every pane in a workspace shares its id prefix (`${workspaceId}:`) —
   * a mode-B spawn puts several panes/agents in ONE workspace, so closing
   * or removing that workspace has to clear all of them in one pass, not
   * just one pane. Called when the workspace itself ends, so a pane id it
   * used never inherits a stale kind/sessionId if herdr later reuses it. */
  removeWorkspace(session: string, workspaceId: string): AgentMeta[] {
    const data = this.#read();
    const rows = data[session];
    if (!rows) return [];
    const prefix = `${workspaceId}:`;
    const removed: AgentMeta[] = [];
    for (const pane of Object.keys(rows)) {
      if (pane.startsWith(prefix)) {
        removed.push(rows[pane]);
        delete rows[pane];
      }
    }
    if (removed.length > 0) this.#write(data);
    return removed;
  }

  /** Every agent row for a whole session — used when the session itself
   * (not just one of its workspaces) is torn down. */
  removeSession(session: string): void {
    const data = this.#read();
    if (data[session] !== undefined) {
      delete data[session];
      this.#write(data);
    }
  }
}

export interface ResumableMeta {
  /** the CLI's own session id — the thing `--resume` takes */
  sessionId: string;
  kind: string;
  /** the directory the conversation happened in. Not decoration: claude
   * stores transcripts under a slug of the cwd, so a resume from somewhere
   * else would silently start a fresh conversation wearing an old id. */
  cwd: string;
  /** ms since epoch, when the agent's pane went away */
  endedAt: number;
  label?: string;
}

/** Conversations whose agent is gone but which a CLI can still resume.
 *
 * This exists because AgentIndex rows are keyed by PANE and deleted when the
 * pane closes — correct for their first job (a reused pane id must not
 * inherit a stale transcript pointer) and exactly wrong for resumption,
 * which is wanted precisely when the pane is gone. Roadmap 31(b): the two
 * are different lifetimes that used to be one field.
 *
 * Keyed by the CLI's session id rather than by pane, because that is the
 * only identifier that survives the pane and the only one `--resume` takes.
 * Rows for agents with no pinned id are never recorded — an unpinnable CLI
 * has nothing to resume BY, and inventing a key would produce a listing
 * entry that cannot be acted on. */
export class ResumableIndex {
  #path: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.#path = join(stateDir, "resumable.json");
  }

  #read(): Record<string, Record<string, ResumableMeta>> {
    return readJson(this.#path, {});
  }

  #write(data: Record<string, Record<string, ResumableMeta>>): void {
    writeFileSync(this.#path, JSON.stringify(data, null, 2) + "\n");
  }

  /** Archive one ended agent. A row with no sessionId is dropped rather
   * than stored: see the class comment. */
  record(session: string, meta: AgentMeta, cwd: string | undefined, label?: string): void {
    if (!meta.sessionId || !cwd) return;
    const data = this.#read();
    (data[session] ??= {})[meta.sessionId] = {
      sessionId: meta.sessionId,
      kind: meta.kind,
      cwd,
      endedAt: Date.now(),
      ...(label ? { label } : {}),
    };
    this.#write(data);
  }

  get(session: string, sessionId: string): ResumableMeta | undefined {
    return this.#read()[session]?.[sessionId];
  }

  /** Newest first — a resume list is read to find the conversation you were
   * just having, not the oldest one on file. */
  all(session: string): ResumableMeta[] {
    return Object.values(this.#read()[session] ?? {}).sort((a, b) => b.endedAt - a.endedAt);
  }

  remove(session: string, sessionId: string): void {
    const data = this.#read();
    if (data[session]?.[sessionId] !== undefined) {
      delete data[session][sessionId];
      this.#write(data);
    }
  }

  removeSession(session: string): void {
    const data = this.#read();
    if (data[session] !== undefined) {
      delete data[session];
      this.#write(data);
    }
  }
}

export function ensureAdminToken(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "admin-token");
  if (!existsSync(path)) writeFileSync(path, mintSecret(), { mode: 0o600 });
  return readFileSync(path, "utf8").trim();
}

export function readLock(stateDir: string): { pid: number; listen: string } | undefined {
  const path = join(stateDir, "daemon.lock");
  return existsSync(path) ? readJson(path, undefined as never) : undefined;
}

export function writeLock(stateDir: string, info: { pid: number; listen: string }): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "daemon.lock"), JSON.stringify(info) + "\n");
}

export function clearLock(stateDir: string): void {
  rmSync(join(stateDir, "daemon.lock"), { force: true });
}
