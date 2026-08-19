import { execFile } from "node:child_process";
import { BrokerError } from "./errors.js";
import type { EnvHookConfig } from "./config.js";

export interface EnvScope {
  kind?: string;
  session?: string;
}

export interface EnvRegistryOpts {
  stateDir: string;
  hooks?: EnvHookConfig[];
  enabled?: boolean;
  /** test seam — production uses the execFile-based runHook below */
  hookRunner?: (hook: EnvHookConfig) => Promise<string>;
}

const NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const VALUE_CAP = 8192;

interface Entry {
  name: string;
  scope: EnvScope;
  value: string;
  set_at: string;
}

function key(name: string, scope: EnvScope): string {
  return `${name} ${scope.kind ?? "*"} ${scope.session ?? "*"}`;
}

/** Higher = more specific: (kind,session)=3 > (kind,*)=2 > (*,session)=1 > (*,*)=0. */
function specificity(scope: EnvScope): number {
  return (scope.kind ? 2 : 0) + (scope.session ? 1 : 0);
}

function scopeMatches(scope: EnvScope, session: string, kind: string): boolean {
  return (
    (scope.kind === undefined || scope.kind === kind) &&
    (scope.session === undefined || scope.session === session)
  );
}

/** In-memory, write-only store of env values plus config-declared hooks.
 * Values must never appear in list() output, errors, or logs (env spec §3/§4). */
export class EnvRegistry {
  readonly enabled: boolean;
  #entries = new Map<string, Entry>();
  #hooks: EnvHookConfig[];
  #stateDir: string;
  #run: (hook: EnvHookConfig) => Promise<string>;

  constructor(opts: EnvRegistryOpts) {
    this.enabled = opts.enabled ?? true;
    this.#stateDir = opts.stateDir;
    this.#hooks = opts.hooks ?? [];
    for (const h of this.#hooks) {
      const ok =
        typeof h.name === "string" && NAME_RE.test(h.name) &&
        Array.isArray(h.command) && h.command.length > 0 && h.command.every((c) => typeof c === "string");
      if (!ok) throw new BrokerError("bad_request", `invalid [[env_hooks]] entry for '${String(h.name)}'`);
    }
    this.#run = opts.hookRunner ?? ((hook) => runHook(hook));
  }

  #guard(): void {
    if (!this.enabled) throw new BrokerError("env_disabled", "env registry is disabled by config");
  }

  set(name: string, value: string, scope: EnvScope): { name: string; scope: EnvScope } {
    this.#guard();
    if (!NAME_RE.test(name)) {
      throw new BrokerError("bad_request", "'name' must match ^[A-Z_][A-Z0-9_]{0,127}$");
    }
    if (Buffer.byteLength(value, "utf8") > VALUE_CAP) {
      throw new BrokerError("bad_request", `'value' exceeds ${VALUE_CAP} bytes`);
    }
    const cleanScope: EnvScope = {
      ...(scope.kind ? { kind: scope.kind } : {}),
      ...(scope.session ? { session: scope.session } : {}),
    };
    this.#entries.set(key(name, cleanScope), { name, scope: cleanScope, value, set_at: new Date().toISOString() });
    return { name, scope: cleanScope };
  }

  list(): Array<{ name: string; scope: EnvScope; source: "manual" | "hook"; set_at?: string }> {
    this.#guard();
    const manual = [...this.#entries.values()].map((e) => ({
      name: e.name,
      scope: e.scope,
      source: "manual" as const,
      set_at: e.set_at,
    }));
    const hooks = this.#hooks.map((h) => ({
      name: h.name,
      scope: { ...(h.kind ? { kind: h.kind } : {}), ...(h.session ? { session: h.session } : {}) },
      source: "hook" as const,
    }));
    return [...manual, ...hooks];
  }

  delete(name: string, scope: EnvScope): void {
    this.#guard();
    const cleanScope: EnvScope = {
      ...(scope.kind ? { kind: scope.kind } : {}),
      ...(scope.session ? { session: scope.session } : {}),
    };
    if (!this.#entries.delete(key(name, cleanScope))) {
      throw new BrokerError("unknown_env", `no env entry '${name}' at that scope`);
    }
  }

  /** Env spec §2 resolver chain: manual (if enabled) beats hook, per name;
   * within each source the most specific matching scope wins. */
  async resolveForSpawn(session: string, kind: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const bestManual = new Map<string, Entry>();
    if (this.enabled) {
      for (const e of this.#entries.values()) {
        if (!scopeMatches(e.scope, session, kind)) continue;
        const prev = bestManual.get(e.name);
        if (!prev || specificity(e.scope) > specificity(prev.scope)) bestManual.set(e.name, e);
      }
    }
    for (const [name, e] of bestManual) out[name] = e.value;
    const bestHook = new Map<string, EnvHookConfig>();
    for (const h of this.#hooks) {
      if (out[h.name] !== undefined) {
        console.error(`[env] manual value overrides hook for ${h.name}`);
        continue;
      }
      if (!scopeMatches({ kind: h.kind, session: h.session }, session, kind)) continue;
      const prev = bestHook.get(h.name);
      if (!prev || specificity({ kind: h.kind, session: h.session }) > specificity({ kind: prev.kind, session: prev.session })) {
        bestHook.set(h.name, h);
      }
    }
    for (const [name, hook] of bestHook) {
      console.error(`[env] running hook for ${name}`);
      out[name] = await this.#run(hook);
    }
    return out;
  }
}

const HOOK_TIMEOUT_DEFAULT = 10_000;

/** Env spec §5a: exec'd directly (never a shell), stdout is the value. Any
 * failure is env_hook_failed — a declared hook means the var is required,
 * and a silently unauthenticated agent is the failure mode this design
 * exists to prevent. Hooks must not print secrets to stderr. */
async function runHook(hook: EnvHookConfig): Promise<string> {
  const timeout = Math.min(Math.max(hook.timeout_ms ?? HOOK_TIMEOUT_DEFAULT, 1001), 60_000);
  const [cmd, ...args] = hook.command;
  const res = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(cmd, args, { timeout, encoding: "utf8", maxBuffer: VALUE_CAP + 1024 }, (err, stdout, stderr) => {
      // On timeout Node kills the child and err.code is null/a signal name —
      // fold every error shape to a non-zero exit.
      const raw = err ? (err as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve({ code: typeof raw === "number" ? raw : err ? 1 : 0, stdout, stderr });
    });
  });
  const stderrLine = res.stderr.split("\n")[0].slice(0, 200);
  if (res.code !== 0) {
    throw new BrokerError("env_hook_failed", `hook for '${hook.name}' exited non-zero`, {
      name: hook.name,
      exit_code: res.code,
      stderr: stderrLine,
    });
  }
  const value = res.stdout.replace(/\n+$/, "");
  if (value.length === 0) {
    throw new BrokerError("env_hook_failed", `hook for '${hook.name}' produced no output`, {
      name: hook.name,
      stderr: stderrLine,
    });
  }
  if (Buffer.byteLength(value, "utf8") > VALUE_CAP) {
    throw new BrokerError("env_hook_failed", `hook for '${hook.name}' output exceeds ${VALUE_CAP} bytes`, {
      name: hook.name,
    });
  }
  return value;
}
