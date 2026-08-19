import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type BrokerConfig } from "./config.js";
import { createHttpHandler, makeCallInstance } from "./http.js";
import { LocalHerdr, type HerdrEndpoint } from "./local-attach.js";
import { Registry } from "./registry.js";
import { ChildrenStore, clearLock, ensureAdminToken, readLock, writeLock } from "./state.js";
import { TunnelHub } from "./tunnel.js";
import { attachUpgradeHandling } from "./ws-server.js";

export interface DaemonOptions {
  configDir: string;
  stateDir: string;
  configOverrides?: Partial<BrokerConfig>;
  localEndpoints?: HerdrEndpoint[];
  herdrVersion?: string;
  projectionDir?: string;
}

export interface DaemonHandle {
  port: number;
  host: string;
  base: string;
  registry: Registry;
  hub: TunnelHub;
  children: ChildrenStore;
  adminToken: string;
  config: BrokerConfig;
  local: LocalHerdr;
  close(): Promise<void>;
}

async function otherDaemonHealthy(stateDir: string): Promise<boolean> {
  const lock = readLock(stateDir);
  if (!lock) return false;
  try {
    const res = await fetch(`http://${lock.listen}/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { name?: string };
    return body.name === "herdr-web-broker";
  } catch {
    return false;
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle | undefined> {
  if (await otherDaemonHealthy(opts.stateDir)) return undefined;

  const config = { ...loadConfig(opts.configDir), ...opts.configOverrides };
  const registry = new Registry(join(opts.stateDir, "registry.json"));
  registry.load();
  const children = new ChildrenStore(opts.stateDir);
  const adminToken = ensureAdminToken(opts.stateDir);

  const local = new LocalHerdr({
    registry,
    herdrVersion: opts.herdrVersion ?? detectHerdrVersion(),
    endpoints: opts.localEndpoints,
    envSocket: opts.localEndpoints ? undefined : process.env.HERDR_SOCKET_PATH,
    defaultSocket: opts.localEndpoints ? undefined : join(homedir(), ".config/herdr/herdr.sock"),
    sessionsDir: opts.localEndpoints ? undefined : join(homedir(), ".config/herdr/sessions"),
  });
  await local.start();

  const hub = new TunnelHub();
  const handler = createHttpHandler({ registry, local, hub, children, config, adminToken });

  const lastColon = config.listen.lastIndexOf(":");
  const host = config.listen.slice(0, lastColon);
  const wantPort = Number(config.listen.slice(lastColon + 1));

  let server: Server;
  try {
    server = config.tls
      ? createHttpsServer(
          { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) },
          handler,
        )
      : createHttpServer(handler);
    attachUpgradeHandling(server, {
      children,
      hub,
      registry,
      config,
      callInstance: makeCallInstance({ registry, local, hub, remoteDeny: config.policy.remote_deny }),
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(wantPort, host, resolve);
    });
  } catch (e) {
    // A failed boot must not orphan the already-started local attach (open sockets + rescan timer).
    local.stop();
    throw e;
  }
  const port = (server.address() as AddressInfo).port;
  writeLock(opts.stateDir, { pid: process.pid, listen: `${host}:${port}` });

  // Task 9 wires ParentLink here; Task 11 wires Projection here.

  const scheme = config.tls ? "https" : "http";
  return {
    port,
    host,
    base: `${scheme}://${host}:${port}`,
    registry,
    hub,
    children,
    adminToken,
    config,
    local,
    async close() {
      local.stop();
      for (const name of hub.names()) hub.disconnect(name);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clearLock(opts.stateDir);
    },
  };
}

function detectHerdrVersion(): string {
  const bin = process.env.HERDR_BIN_PATH ?? "herdr";
  const out = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : "unknown";
}

async function main(): Promise<void> {
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? join(homedir(), ".config/herdr-web-broker");
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), ".local/state/herdr-web-broker");
  const handle = await startDaemon({ configDir, stateDir });
  if (!handle) {
    console.log("herdr-web-broker: healthy daemon already running, exiting");
    return;
  }
  console.log(`herdr-web-broker: listening on ${handle.base}`);
  const shutdown = () => void handle.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
