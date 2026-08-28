import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { hashSecret } from "./auth.js";
import type { CliConfig } from "./cli-profiles.js";
import type { ModelsConfig } from "./model-registry.js";
import type { ModuleSpec } from "./module-loader.js";
import { DEFAULT_REMOTE_DENY } from "./policy.js";

export interface ClientToken {
  name: string;
  /** legacy/dev plaintext — normalized to token_hash at boot */
  token?: string;
  /** sha256 hex — the at-rest form; the plaintext is shown once at mint */
  token_hash?: string;
}

/** Converts plaintext entries to their hashed form in place. Returns
 * whether anything changed, so the daemon knows to persist a config that
 * arrived from disk with plaintext secrets. */
export function normalizeClientTokens(tokens: ClientToken[]): boolean {
  let changed = false;
  for (const t of tokens) {
    if (t.token !== undefined) {
      t.token_hash = hashSecret(t.token);
      delete t.token;
      changed = true;
    }
  }
  return changed;
}

export interface ParentConfig {
  address: string;
  secret: string;
  name: string;
}

export interface EnvHookConfig {
  name: string;
  kind?: string;
  session?: string;
  command: string[];
  timeout_ms?: number;
}

export interface BrokerConfig {
  listen: string;
  client_tokens: ClientToken[];
  parent?: ParentConfig;
  policy: { remote_deny: string[] };
  tls?: { cert: string; key: string };
  env_registry: { enabled: boolean };
  env_hooks: EnvHookConfig[];
  /** dev-environment token generator (POST /admin/tokens) — off by default */
  token_mint: { enabled: boolean };
  /** model catalog rows + switch templates layered over the builtins */
  models?: ModelsConfig;
  /** per-CLI transcript/pin/prepare profiles layered over the builtins */
  cli?: CliConfig;
  /** operator-installed modules. Read ONCE at boot and deliberately NOT
   * hot-reloaded with the rest of this file: re-importing mid-flight
   * leaks whatever the old instance closed over, and a route table
   * changing under live requests is the wrong trade for a feature whose
   * appeal is predictability. */
  modules?: ModuleSpec[];
}

export const DEFAULT_LISTEN = "127.0.0.1:7591";

export function loadConfig(configDir: string): BrokerConfig {
  const path = join(configDir, "config.toml");
  const raw = existsSync(path) ? (parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  const policy = (raw.policy ?? {}) as { remote_deny?: string[] };
  return {
    listen: (raw.listen as string) ?? DEFAULT_LISTEN,
    client_tokens: (raw.client_tokens as ClientToken[]) ?? [],
    parent: raw.parent as ParentConfig | undefined,
    policy: { remote_deny: policy.remote_deny ?? [...DEFAULT_REMOTE_DENY] },
    tls: raw.tls as { cert: string; key: string } | undefined,
    env_registry: { enabled: (raw.env_registry as { enabled?: boolean } | undefined)?.enabled ?? true },
    env_hooks: (raw.env_hooks as EnvHookConfig[]) ?? [],
    token_mint: { enabled: (raw.token_mint as { enabled?: boolean } | undefined)?.enabled ?? false },
    models: raw.models as ModelsConfig | undefined,
    cli: raw.cli as CliConfig | undefined,
    modules: raw.modules as ModuleSpec[] | undefined,
  };
}

/** Rewrites config.toml wholesale — operator comments are not preserved (v1, documented). */
export function saveConfig(configDir: string, config: BrokerConfig): void {
  mkdirSync(configDir, { recursive: true });
  const out: Record<string, unknown> = {
    listen: config.listen,
    client_tokens: config.client_tokens,
    policy: config.policy,
  };
  if (config.parent) out.parent = config.parent;
  if (config.tls) out.tls = config.tls;
  out.env_registry = config.env_registry;
  if (config.env_hooks.length > 0) out.env_hooks = config.env_hooks;
  if (config.token_mint.enabled) out.token_mint = config.token_mint;
  if (config.models) out.models = config.models;
  if (config.cli) out.cli = config.cli;
  if (config.modules) out.modules = config.modules;
  writeFileSync(join(configDir, "config.toml"), stringify(out) + "\n");
}
