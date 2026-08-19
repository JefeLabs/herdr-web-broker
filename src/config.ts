import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
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

export interface BrokerConfig {
  listen: string;
  client_tokens: ClientToken[];
  parent?: ParentConfig;
  policy: { remote_deny: string[] };
  tls?: { cert: string; key: string };
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
  writeFileSync(join(configDir, "config.toml"), stringify(out) + "\n");
}
