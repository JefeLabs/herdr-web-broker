import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { ModelsConfig } from "./model-registry.js";
import { DEFAULT_REMOTE_DENY } from "./policy.js";

export interface ClientToken {
  name: string;
  token: string;
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
  /** model catalog rows + switch templates layered over the builtins */
  models?: ModelsConfig;
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
    models: raw.models as ModelsConfig | undefined,
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
  if (config.models) out.models = config.models;
  writeFileSync(join(configDir, "config.toml"), stringify(out) + "\n");
}
