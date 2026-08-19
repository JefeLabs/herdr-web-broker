import { existsSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { BrokerError } from "./errors.js";
import { encodeFrame, NdjsonDecoder } from "./ndjson.js";
import type { AgentInfo, AgentStatus, InstanceSnapshot, Registry } from "./registry.js";
import { DEFAULT_TIMEOUT_MS } from "./tunnel.js";

export interface HerdrEndpoint {
  session: string;
  socketPath: string;
}

/** herdr's native agent vocabulary is idle|working|blocked|done|unknown
 * (validated against herdr 0.8.0's `api schema`); the broker's three-bucket
 * counts fold done and unknown into idle. */
function coerceStatus(status: unknown): AgentStatus {
  return status === "working" || status === "blocked" ? status : "idle";
}

/** Validated against herdr 0.8.0: agent.list returns
 * { type: "agent_list", agents: [{ pane_id, name, agent_status, ... }] }. */
export function mapAgentList(result: unknown): AgentInfo[] {
  const r = result as {
    agents?: Array<{ pane_id?: unknown; name?: unknown; agent_status?: unknown }>;
  };
  if (!Array.isArray(r?.agents)) return [];
  return r.agents.map((a) => ({
    id: String(a.pane_id ?? ""),
    title: String(a.name ?? a.pane_id ?? "agent"),
    status: coerceStatus(a.agent_status),
  }));
}

/** Validated against herdr 0.8.0: streamed frames on an event channel look
 * like { event: "<snake_case_name>", data: {...} }. Status changes carry
 * { pane_id, workspace_id, agent_status, agent?, display_agent?, title? };
 * pane/agent lifecycle events are cheap triggers to re-list agents. */
export function mapHerdrEvent(
  frame: unknown,
): { agent: AgentInfo } | { refresh: true } | undefined {
  const f = frame as { event?: string; data?: Record<string, unknown> };
  if (typeof f?.event !== "string" || !f.data) return undefined;
  if (f.event === "pane_agent_status_changed" && typeof f.data.pane_id === "string") {
    return {
      agent: {
        id: f.data.pane_id,
        title: String(f.data.display_agent ?? f.data.agent ?? f.data.title ?? f.data.pane_id),
        status: coerceStatus(f.data.agent_status),
      },
    };
  }
  if (["pane_agent_detected", "pane_created", "pane_exited", "pane_closed"].includes(f.event)) {
    return { refresh: true };
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

// Local herdr responses (e.g. a big pane.read/agent.read) legitimately carry
// a large single-line result — well past the 1MB wire default that guards
// untrusted remote frames.
const LOCAL_MAX_BUF_BYTES = 32 * 1_048_576;

/** herdr serves ONE request per connection (its own CLI works the same way):
 * connect, send, read the single reply, and the server closes the socket. */
export function oneShotRpc(
  socketPath: string,
  method: string,
  params: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const dec = new NdjsonDecoder(LOCAL_MAX_BUF_BYTES);
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new BrokerError("upstream_timeout", `local ${method} exceeded ${timeoutMs}ms`))),
      timeoutMs,
    );
    sock.once("connect", () => sock.write(encodeFrame({ id: "1", method, params })));
    sock.on("error", (e) =>
      settle(() => reject(new BrokerError("instance_offline", `local herdr socket: ${e.message}`))),
    );
    sock.on("close", () =>
      settle(() => reject(new BrokerError("instance_offline", "local herdr socket closed"))),
    );
    sock.on("data", (chunk) => {
      let frames: unknown[];
      try {
        frames = dec.push(chunk);
      } catch {
        // an inbound frame must never crash the daemon
        settle(() => reject(new BrokerError("upstream_error", "malformed reply from herdr")));
        return;
      }
      const f = frames[0] as
        | { result?: unknown; error?: { code: string; message: string } }
        | undefined;
      if (!f) return; // partial line — keep reading
      if (f.error) settle(() => reject(new BrokerError(f.error!.code, f.error!.message)));
      else settle(() => resolve(f.result));
    });
  });
}

/** Subscriptions herdr accepts without a pane_id — enough to know WHEN the
 * agent roster changed; the refresh re-lists it. Per-pane status streams
 * (which require pane_id) are future work. */
const EVENT_SUBSCRIPTIONS = [
  { type: "pane.agent_detected" },
  { type: "pane.created" },
  { type: "pane.exited" },
];

/** A dedicated event channel: after events.subscribe succeeds herdr treats
 * the connection as event-only (further requests are rejected), so it is
 * held open purely to receive { event, data } frames. */
class SessionEvents {
  #sock: ReturnType<typeof connect>;
  #dec = new NdjsonDecoder(LOCAL_MAX_BUF_BYTES);

  constructor(
    readonly socketPath: string,
    onFrame: (frame: unknown) => void,
    onClose: () => void,
  ) {
    this.#sock = connect(socketPath);
    this.#sock.once("connect", () =>
      this.#sock.write(
        encodeFrame({ id: "sub", method: "events.subscribe", params: { subscriptions: EVENT_SUBSCRIPTIONS } }),
      ),
    );
    this.#sock.on("data", (chunk) => {
      let frames: unknown[];
      try {
        frames = this.#dec.push(chunk);
      } catch {
        // an inbound frame must never crash the daemon
        this.#sock.destroy();
        return;
      }
      for (const frame of frames) onFrame(frame);
    });
    this.#sock.on("error", () => this.#sock.destroy());
    this.#sock.on("close", onClose);
  }

  close(): void {
    this.#sock.destroy();
  }
}

interface TrackedSession {
  socketPath: string;
  events: SessionEvents;
}

export class LocalHerdr {
  #sessions = new Map<string, TrackedSession>();
  #connecting = new Set<string>();
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
      if (this.#sessions.has(ep.session) || this.#connecting.has(ep.session)) continue;
      this.#connecting.add(ep.session);
      try {
        // one-shot probe proves the socket answers before we commit to it
        await oneShotRpc(ep.socketPath, "ping", {}, 5000);
        if (this.#stopped) return;
        const tracked: TrackedSession = {
          socketPath: ep.socketPath,
          events: new SessionEvents(
            ep.socketPath,
            (frame) => this.#onEvent(ep.session, frame),
            () => {
              // Only the session's registered event channel retires it — a
              // channel that lost a startup race must not evict its successor.
              if (this.#sessions.get(ep.session) === tracked && !this.#stopped) {
                this.#sessions.delete(ep.session);
                this.opts.registry.applySessionRemoved("runtime", ep.session);
              }
            },
          ),
        };
        this.#sessions.set(ep.session, tracked);
        await this.#refresh(ep.session);
      } catch {
        // socket not answering right now; next rescan retries
      } finally {
        this.#connecting.delete(ep.session);
      }
    }
  }

  #onEvent(session: string, frame: unknown): void {
    const mapped = mapHerdrEvent(frame);
    if (!mapped) return;
    if ("agent" in mapped) {
      this.opts.registry.applyAgentStatus("runtime", session, mapped.agent);
    } else {
      void this.#refresh(session);
    }
  }

  async #refresh(session: string): Promise<void> {
    const tracked = this.#sessions.get(session);
    if (!tracked || this.#stopped) return;
    const agents = mapAgentList(await oneShotRpc(tracked.socketPath, "agent.list", {}).catch(() => ({})));
    if (!this.#stopped && this.#sessions.has(session)) {
      this.opts.registry.applySessionAdded("runtime", { name: session, agents });
    }
  }

  sessions(): string[] {
    return [...this.#sessions.keys()];
  }

  request(session: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const tracked = this.#sessions.get(session);
    if (!tracked) {
      return Promise.reject(new BrokerError("unknown_session", `no local session '${session}'`));
    }
    return oneShotRpc(tracked.socketPath, method, params, timeoutMs);
  }

  async snapshot(): Promise<InstanceSnapshot> {
    const sessions = [];
    for (const [name, tracked] of this.#sessions) {
      const agents = mapAgentList(await oneShotRpc(tracked.socketPath, "agent.list", {}).catch(() => ({})));
      sessions.push({ name, agents });
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
    for (const tracked of this.#sessions.values()) tracked.events.close();
    this.#sessions.clear();
  }
}
