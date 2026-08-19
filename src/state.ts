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
 * spawned team belongs to (spec §4 fallback source). */
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
