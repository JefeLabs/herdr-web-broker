import { existsSync, readdirSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { BrokerError } from "./errors.js";
import { encodeFrame, NdjsonDecoder } from "./ndjson.js";
import type { AgentInfo, AgentStatus, InstanceSnapshot, Registry } from "./registry.js";
import { DEFAULT_TIMEOUT_MS } from "./tunnel.js";

export interface HerdrEndpoint {
  session: string;
  socketPath: string;
}

/** ASSUMPTION (validated by live smoke, spec Global note): agent.list returns
 * { agents: [{ id, title, status }] } with status ∈ working|blocked|idle. */
export function mapAgentList(result: unknown): AgentInfo[] {
  const r = result as { agents?: Array<{ id?: unknown; title?: unknown; status?: unknown }> };
  if (!Array.isArray(r?.agents)) return [];
  return r.agents.map((a) => ({
    id: String(a.id ?? ""),
    title: String(a.title ?? ""),
    status: (a.status === "working" || a.status === "blocked" ? a.status : "idle") as AgentStatus,
  }));
}

/** ASSUMPTION (validated by live smoke): streamed frames look like
 * { event: { type: "pane.agent_status_changed", agent: {...} } } — the fake
 * wraps emitEvent() payloads in { event }, matching this shape. */
export function mapHerdrEvent(frame: unknown): { agent: AgentInfo } | undefined {
  const f = frame as { event?: { type?: string; agent?: AgentInfo } };
  if (f?.event?.type === "pane.agent_status_changed" && f.event.agent) {
    return { agent: f.event.agent };
  }
  return undefined;
}

export function discoverEndpoints(opts: {
  sessionsDir?: string;
  defaultSocket?: string;
  envSocket?: string;
}): HerdrEndpoint[] {
  const seen = new Map<string, HerdrEndpoint>();
  const add = (session: string, socketPath: string) => {
    if (existsSync(socketPath) && !seen.has(socketPath)) seen.set(socketPath, { session, socketPath });
  };
  if (opts.envSocket) {
    const named = /sessions\/([^/]+)\/herdr\.sock$/.exec(opts.envSocket);
    add(named ? named[1] : "default", opts.envSocket);
  }
  if (opts.defaultSocket) add("default", opts.defaultSocket);
  if (opts.sessionsDir && existsSync(opts.sessionsDir)) {
    for (const name of readdirSync(opts.sessionsDir)) {
      add(name, join(opts.sessionsDir, name, "herdr.sock"));
    }
  }
  return [...seen.values()];
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class SessionConn {
  #sock?: Socket;
  #dec = new NdjsonDecoder();
  #pending = new Map<string, Pending>();
  #seq = 0;

  constructor(
    readonly session: string,
    readonly socketPath: string,
    private onEvent: (frame: unknown) => void,
    private onClose: () => void,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      this.#sock = sock;
      sock.once("connect", resolve);
      sock.once("error", reject);
      sock.on("data", (chunk) => {
        for (const frame of this.#dec.push(chunk)) this.#route(frame);
      });
      sock.on("close", () => {
        for (const p of this.#pending.values()) {
          clearTimeout(p.timer);
          p.reject(new BrokerError("instance_offline", "local herdr socket closed"));
        }
        this.#pending.clear();
        this.onClose();
      });
    });
  }

  #route(frame: unknown): void {
    const f = frame as { id?: string; result?: unknown; error?: { code: string; message: string } };
    const pending = f.id ? this.#pending.get(f.id) : undefined;
    if (!pending) {
      this.onEvent(frame);
      return;
    }
    this.#pending.delete(f.id!);
    clearTimeout(pending.timer);
    if (f.error) pending.reject(new BrokerError(f.error.code, f.error.message));
    else pending.resolve(f.result);
  }

  rpc(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const id = `l${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BrokerError("upstream_timeout", `local ${method} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#sock?.write(encodeFrame({ id, method, params }));
    });
  }

  close(): void {
    this.#sock?.destroy();
  }
}

export class LocalHerdr {
  #conns = new Map<string, SessionConn>();
  #timer?: NodeJS.Timeout;
  #stopped = false;

  constructor(
    private opts: {
      registry: Registry;
      herdrVersion: string;
      endpoints?: HerdrEndpoint[];
      sessionsDir?: string;
      defaultSocket?: string;
      envSocket?: string;
      rescanMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    await this.#rescan();
    this.opts.registry.replaceSnapshot("runtime", await this.snapshot());
    const interval = this.opts.rescanMs ?? 15_000;
    this.#timer = setInterval(() => void this.#rescan(), interval);
    this.#timer.unref();
  }

  async #rescan(): Promise<void> {
    if (this.#stopped) return;
    const endpoints = this.opts.endpoints ?? discoverEndpoints(this.opts);
    for (const ep of endpoints) {
      if (this.#conns.has(ep.session)) continue;
      const conn = new SessionConn(
        ep.session,
        ep.socketPath,
        (frame) => {
          const mapped = mapHerdrEvent(frame);
          if (mapped) this.opts.registry.applyAgentStatus("runtime", ep.session, mapped.agent);
        },
        () => {
          this.#conns.delete(ep.session);
          if (!this.#stopped) this.opts.registry.applySessionRemoved("runtime", ep.session);
        },
      );
      try {
        await conn.connect();
        this.#conns.set(ep.session, conn);
        await conn
          .rpc("events.subscribe", {
            subscriptions: [{ type: "pane.agent_status_changed" }],
          })
          .catch(() => undefined);
        const agents = mapAgentList(await conn.rpc("agent.list", {}).catch(() => ({})));
        this.opts.registry.applySessionAdded("runtime", { name: ep.session, agents });
      } catch {
        // socket not connectable right now; next rescan retries
      }
    }
  }

  sessions(): string[] {
    return [...this.#conns.keys()];
  }

  request(session: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const conn = this.#conns.get(session);
    if (!conn) {
      return Promise.reject(new BrokerError("unknown_session", `no local session '${session}'`));
    }
    return conn.rpc(method, params, timeoutMs);
  }

  async snapshot(): Promise<InstanceSnapshot> {
    const sessions = [];
    for (const conn of this.#conns.values()) {
      const agents = mapAgentList(await conn.rpc("agent.list", {}).catch(() => ({})));
      sessions.push({ name: conn.session, agents });
    }
    const platformMap: Record<string, string> = { darwin: "macos", win32: "windows" };
    return {
      platform: platformMap[process.platform] ?? process.platform,
      herdr_version: this.opts.herdrVersion,
      sessions,
    };
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    for (const conn of this.#conns.values()) conn.close();
    this.#conns.clear();
  }
}
