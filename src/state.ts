import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintSecret } from "./auth.js";

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
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
