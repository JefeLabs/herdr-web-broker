import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, normalizeClientTokens, saveConfig, type BrokerConfig } from "./config.js";
import { Audit } from "./audit.js";
import { AuthLimiter } from "./auth-limit.js";
import { EnvRegistry } from "./env-registry.js";
import { createHttpHandler, makeCallInstance } from "./http.js";
import { LocalHerdr, type HerdrEndpoint } from "./local-attach.js";
import { ModelRegistry } from "./model-registry.js";
import { OwnerRegistry } from "./owners.js";
import { HerdrProvisioner, type SessionProvisioner } from "./provisioner.js";
import { Presence } from "./presence.js";
import { Projection } from "./projection.js";
import { Registry } from "./registry.js";
import { ParentLink } from "./south.js";
import {
  AgentIndex,
  ChildrenStore,
  ResumableIndex,
  WorkspaceIndex,
  clearLock,
  ensureAdminToken,
  readLock,
  writeLock,
} from "./state.js";
import { CliProfiles } from "./cli-profiles.js";
import { BrokerEvents } from "./broker-events.js";
import { loadModules, type LoadedModule } from "./module-loader.js";
import { TunnelHub } from "./tunnel.js";
import { verdictFor } from "./version.js";
import { reapWorkspaceRow, type OpsDeps } from "./workspace-ops.js";
import { attachUpgradeHandling, type UpgradeHandle } from "./ws-server.js";

export interface DaemonOptions {
  configDir: string;
  stateDir: string;
  configOverrides?: Partial<BrokerConfig>;
  localEndpoints?: HerdrEndpoint[];
  herdrVersion?: string;
  projectionDir?: string;
  /** client-WS keepalive ping interval (test override) */
  wsPingMs?: number;
  /** session-ownership provisioner override (tests, devstack); the real
   * exec-based one is used only when running against real herdr */
  provisioner?: SessionProvisioner;
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
  /** The broker's own event bus. Exposed so a caller can observe pushes the
   * HTTP surface does not expose — `broker.workspace.reaped` (roadmap 31f)
   * is announced here and nowhere else without a WS client. */
  events: BrokerEvents;
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
  // Hash any plaintext client tokens. Persist only when they came from the
  // config FILE (overrides — dev stacks, tests — stay in memory).
  if (normalizeClientTokens(config.client_tokens) && opts.configOverrides?.client_tokens === undefined) {
    saveConfig(opts.configDir, config);
  }
  // herdr compatibility gate. Detection already happened below via
  // detectHerdrVersion(); until now nothing acted on the result. The
  // asymmetry is deliberate — see verdictFor: below the floor is
  // known-incompatible and refuses, above the tested ceiling is merely
  // unknown and warns, because refusing there would turn a
  // possibly-working setup into a guaranteed outage on every herdr
  // upgrade. Tests inject herdrVersion, so they bypass the spawn, not
  // the policy.
  const herdrVersion = opts.herdrVersion ?? detectHerdrVersion();
  const verdict = verdictFor(herdrVersion);
  if (!verdict.ok) throw new Error(`herdr-web-broker: ${verdict.refuse}`);
  if ("warn" in verdict) console.warn(`herdr-web-broker: WARNING — ${verdict.warn}`);

  const registry = new Registry(join(opts.stateDir, "registry.json"));
  registry.load();
  const children = new ChildrenStore(opts.stateDir);
  const index = new WorkspaceIndex(opts.stateDir);
  const agents = new AgentIndex(opts.stateDir);
  const resumable = new ResumableIndex(opts.stateDir);
  const adminToken = ensureAdminToken(opts.stateDir);

  // Roadmap 31(f), late-bound on purpose: LocalHerdr is built before `ops`
  // (which holds it) and before the event bus, so the hook cannot be handed
  // in at construction. A reap arriving in that window is simply not healed —
  // the row waits for the next one or an explicit close, which is the same
  // degrade as the event channel being down.
  let onReaped: ((session: string, workspaceId: string) => void) | undefined;
  const local = new LocalHerdr({
    registry,
    onWorkspaceReaped: (session, workspaceId) => onReaped?.(session, workspaceId),
    herdrVersion,
    endpoints: opts.localEndpoints,
    envSocket: opts.localEndpoints ? undefined : process.env.HERDR_SOCKET_PATH,
    defaultSocket: opts.localEndpoints ? undefined : join(homedir(), ".config/herdr/herdr.sock"),
    sessionsDir: opts.localEndpoints ? undefined : join(homedir(), ".config/herdr/sessions"),
  });
  await local.start();
  const ops: OpsDeps = {
    local,
    registry,
    index,
    env: new EnvRegistry({ stateDir: opts.stateDir, hooks: config.env_hooks, enabled: config.env_registry.enabled }),
    models: new ModelRegistry(config.models),
    agents,
    resumable,
    profiles: new CliProfiles(config.cli),
    stateDir: opts.stateDir,
    ...(config.spawn?.readiness_timeout_ms !== undefined
      ? { readinessTimeoutMs: config.spawn.readiness_timeout_ms }
      : {}),
  };

  const hub = new TunnelHub();
  // One failed-auth limiter across HTTP and the WS upgrade path.
  const limiter = new AuthLimiter();
  // Session ownership (spec 2026-08-22): bindings always load; the real
  // exec-based provisioner only exists when running against real herdr.
  const owners = new OwnerRegistry(opts.stateDir);
  const provisioner =
    opts.provisioner ??
    (opts.localEndpoints
      ? undefined
      : new HerdrProvisioner({
          sessionsDir: join(homedir(), ".config/herdr/sessions"),
          logDir: opts.stateDir,
        }));
  const audit = new Audit(join(opts.stateDir, "audit.log"));

  // Modules load ONCE, here. config.toml keeps hot-reloading
  // client_tokens; [[modules]] is deliberately exempt — re-importing
  // mid-flight leaks whatever the old instance closed over.
  const brokerEvents = new BrokerEvents();
  ops.events = brokerEvents;
  // Heal AND announce. The heal shares reapWorkspaceRow with the two call
  // paths in workspace-ops, which is what makes it safe for this to fire in
  // the middle of the close that caused it. The announcement is the part
  // 31(f) actually asked for: the divergence used to sit unremarked until
  // somebody thought to call GET .../orphans.
  onReaped = (session, workspaceId) => {
    const indexed = reapWorkspaceRow(ops, session, workspaceId);
    brokerEvents.emit("broker.workspace.reaped", { session, workspace_id: workspaceId, indexed });
  };
  const modules: LoadedModule[] = await loadModules(config.modules ?? [], {
    deps: ops,
    session: "default",
    instance: "runtime",
    events: brokerEvents,
    log: (m) => console.warn(m),
    audit,
  });
  for (const m of modules) {
    // The configured set belongs in the trail, not only in a file:
    // "which extensions was this broker running" should be answerable
    // after the fact.
    audit.record({
      action: m.error ? "module_refused" : "module_loaded",
      actor: "boot",
      target: `${m.id} (${m.granted.join(",") || "no caps"})`,
    });
    if (!m.error) {
      console.warn(`[modules] loaded ${m.id} — ${m.routes.length} route(s), caps: ${m.granted.join(",") || "none"}`);
    }
  }
  let link: ParentLink | undefined;
  const startLink = (cfg: BrokerConfig) => {
    link?.stop();
    link = undefined;
    if (cfg.parent) {
      link = new ParentLink({
        address: cfg.parent.address,
        secret: cfg.parent.secret,
        name: cfg.parent.name,
        local,
        registry,
        remoteDeny: cfg.policy.remote_deny,
        ops,
      });
      link.start();
    }
  };
  const handler = createHttpHandler({
    registry,
    local,
    hub,
    children,
    config,
    adminToken,
    ops,
    onReload: () => startLink({ ...loadConfig(opts.configDir), ...opts.configOverrides }),
    onTokensChanged: () => saveConfig(opts.configDir, config),
    presence: new Presence(),
    // late-bound: `upgrade` exists once the server is listening
    onKickSockets: (tokenName) => upgrade?.closeToken(tokenName) ?? 0,
    limiter,
    audit,
    owners,
    modules,
    brokerEvents,
    ...(provisioner ? { provisioner } : {}),
  });

  const lastColon = config.listen.lastIndexOf(":");
  const host = config.listen.slice(0, lastColon);
  const wantPort = Number(config.listen.slice(lastColon + 1));

  let server: Server;
  let upgrade: UpgradeHandle;
  try {
    server = config.tls
      ? createHttpsServer(
          { cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key) },
          handler,
        )
      : createHttpServer(handler);
    upgrade = attachUpgradeHandling(server, {
      children,
      hub,
      registry,
      config,
      callInstance: makeCallInstance({ registry, local, hub, remoteDeny: config.policy.remote_deny, ops }),
      pingIntervalMs: opts.wsPingMs,
      limiter,
      local,
      owners,
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

  startLink(config);
  const projection = new Projection({
    dir: opts.projectionDir ?? join(homedir(), ".config/herdr/remotes"),
    hub,
    registry,
    remoteDeny: config.policy.remote_deny,
  });
  projection.start();

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
    events: brokerEvents,
    async close() {
      link?.stop();
      projection.stop();
      local.stop();
      for (const name of hub.names()) hub.disconnect(name);
      // A lingering client connection must not hang shutdown. Plain HTTP
      // keep-alive sockets are covered by closeAllConnections(); a socket
      // handed off via the 'upgrade' event is no longer tracked as an HTTP
      // connection at all (only ws's WebSocketServer.clients still sees
      // it), so it needs its own termination or server.close() never calls
      // its callback.
      server.closeAllConnections();
      upgrade.closeAllConnections();
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
