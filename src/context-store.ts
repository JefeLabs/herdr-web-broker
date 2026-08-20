import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError } from "./errors.js";

/** Workspace context attachments (PDFs, images, notes the human uploads for
 * the agent). They live in <cwd>/.herdr/context/ — a hidden dir the repo
 * scan skips — and <cwd>/.herdr/.gitignore ("*") keeps them out of git
 * status/tree/diff even when the workspace root is itself a repo. Active
 * attachments are listed in the text sent by ask/prompt/spec so the agent
 * knows to read them. */

export const CONTEXT_CAP_BYTES = 8 * 1024 * 1024;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/;
const META = ".meta.json";

export interface ContextMeta {
  content_type: string;
  active: boolean;
  uploaded_at: string;
}

export interface ContextEntry extends ContextMeta {
  name: string;
  size: number;
}

function dirOf(cwd: string): string {
  return join(cwd, ".herdr", "context");
}

function ensureDir(cwd: string): string {
  const dir = dirOf(cwd);
  mkdirSync(dir, { recursive: true });
  const ignore = join(cwd, ".herdr", ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return dir;
}

function checkName(name: string): string {
  if (!NAME.test(name) || name.length > 128) {
    throw new BrokerError("bad_request", "'name' must be a plain file name ([a-zA-Z0-9._ -], no leading dot, no path)");
  }
  return name;
}

function readMeta(dir: string): Record<string, ContextMeta> {
  try {
    return JSON.parse(readFileSync(join(dir, META), "utf8")) as Record<string, ContextMeta>;
  } catch {
    return {};
  }
}

function writeMeta(dir: string, meta: Record<string, ContextMeta>): void {
  writeFileSync(join(dir, META), JSON.stringify(meta, null, 2));
}

export function putContext(
  cwd: string,
  name: string,
  content: Buffer,
  opts: { contentType?: string; active?: boolean },
): ContextEntry {
  checkName(name);
  if (content.length > CONTEXT_CAP_BYTES) {
    throw new BrokerError("bad_request", "attachment exceeds the 8MB cap");
  }
  const dir = ensureDir(cwd);
  writeFileSync(join(dir, name), content);
  const meta = readMeta(dir);
  meta[name] = {
    content_type: opts.contentType ?? "application/octet-stream",
    active: opts.active ?? true,
    uploaded_at: new Date().toISOString(),
  };
  writeMeta(dir, meta);
  return { name, size: content.length, ...meta[name] };
}

export function listContext(cwd: string): ContextEntry[] {
  const dir = dirOf(cwd);
  if (!existsSync(dir)) return [];
  const meta = readMeta(dir);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort()
    .map((name) => ({
      name,
      size: statSync(join(dir, name)).size,
      content_type: meta[name]?.content_type ?? "application/octet-stream",
      active: meta[name]?.active ?? true,
      uploaded_at: meta[name]?.uploaded_at ?? "",
    }));
}

function mustExist(cwd: string, name: string): string {
  checkName(name);
  const file = join(dirOf(cwd), name);
  if (!existsSync(file)) throw new BrokerError("unknown_context", `no context attachment '${name}'`);
  return file;
}

export function getContext(cwd: string, name: string): { content: Buffer; meta: ContextEntry } {
  const file = mustExist(cwd, name);
  const content = readFileSync(file);
  const entry = listContext(cwd).find((e) => e.name === name)!;
  return { content, meta: entry };
}

export function setContextActive(cwd: string, name: string, active: boolean): ContextEntry {
  mustExist(cwd, name);
  const dir = dirOf(cwd);
  const meta = readMeta(dir);
  meta[name] = {
    content_type: meta[name]?.content_type ?? "application/octet-stream",
    active,
    uploaded_at: meta[name]?.uploaded_at ?? new Date().toISOString(),
  };
  writeMeta(dir, meta);
  return listContext(cwd).find((e) => e.name === name)!;
}

export function deleteContext(cwd: string, name: string): void {
  const file = mustExist(cwd, name);
  rmSync(file, { force: true });
  const dir = dirOf(cwd);
  const meta = readMeta(dir);
  delete meta[name];
  writeMeta(dir, meta);
}

const human = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`);

/** The injection line for ask/prompt/spec: active attachments only, with
 * absolute paths the agent can open. undefined when nothing is active. */
export function activeContextPreamble(cwd: string): string | undefined {
  const active = listContext(cwd).filter((e) => e.active);
  if (active.length === 0) return undefined;
  const items = active.map((e) => `${join(dirOf(cwd), e.name)} (${e.content_type}, ${human(e.size)})`).join("; ");
  return `Context files attached by the human (read them as needed): ${items}`;
}
