import type WebSocket from "ws";
import { BrokerError } from "./errors.js";
import type { AgentInfo, InstanceSnapshot, Registry, SessionSnapshot } from "./registry.js";

export const PROTO_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const HEARTBEAT_MS = 15_000;

export type TunnelEvent =
  | { kind: "agent_status"; session: string; agent: AgentInfo }
  | { kind: "session_added"; session: SessionSnapshot }
  | { kind: "session_removed"; session: string }
  | { kind: "snapshot"; snapshot: InstanceSnapshot };

export type TunnelFrame =
  | {
      type: "hello";
      name: string;
      platform: string;
      herdr_version: string;
      plugin_version: string;
      proto: number;
      sessions: SessionSnapshot[];
    }
  | { type: "welcome"; name: string; proto: number }
  | { type: "req"; id: string; session: string; method: string; params?: unknown; timeout_ms?: number }
  | { type: "res"; id: string; result?: unknown; error?: { code: string; message: string } }
  | { type: "event"; event: TunnelEvent };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Parent-side wrapper around one enrolled child's WebSocket. */
export class ChildConnection {
  #pending = new Map<string, Pending>();
  #seq = 0;
  #missedPongs = 0;
  #heartbeat: NodeJS.Timeout;

  constructor(
    readonly name: string,
    private ws: WebSocket,
    private registry: Registry,
    private onGone: () => void,
  ) {
    ws.on("message", (data) => {
      let frame: TunnelFrame;
      try {
        // An inbound frame must never crash the daemon.
        frame = JSON.parse(String(data)) as TunnelFrame;
      } catch {
        ws.terminate();
        return;
      }
      this.#route(frame);
    });
    ws.on("pong", () => (this.#missedPongs = 0));
    this.#heartbeat = setInterval(() => {
      this.#missedPongs += 1;
      if (this.#missedPongs > 2) {
        ws.terminate();
        return;
      }
      ws.ping();
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
    ws.on("close", () => this.#gone());
    ws.on("error", () => this.#gone());
  }

  #gone(): void {
    clearInterval(this.#heartbeat);
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new BrokerError("instance_offline", `tunnel to '${this.name}' closed`));
    }
    this.#pending.clear();
    this.onGone();
  }

  #route(frame: TunnelFrame): void {
    if (frame.type === "res") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) pending.reject(new BrokerError(frame.error.code, frame.error.message));
      else pending.resolve(frame.result);
    } else if (frame.type === "event") {
      const e = frame.event;
      if (e.kind === "agent_status") this.registry.applyAgentStatus(this.name, e.session, e.agent);
      else if (e.kind === "session_added") this.registry.applySessionAdded(this.name, e.session);
      else if (e.kind === "session_removed") this.registry.applySessionRemoved(this.name, e.session);
      else if (e.kind === "snapshot") this.registry.replaceSnapshot(this.name, e.snapshot);
    }
  }

  request(session: string, method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const id = `${this.name}:${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new BrokerError("upstream_timeout", `'${this.name}' gave no response in ${timeoutMs}ms`, {
            instance: this.name,
          }),
        );
      }, timeoutMs + 1000); // child applies timeoutMs to its local call; grace for transit
      this.#pending.set(id, { resolve, reject, timer });
      this.ws.send(
        JSON.stringify({ type: "req", id, session, method, params, timeout_ms: timeoutMs }),
      );
    });
  }

  close(): void {
    this.ws.close();
  }
}

export class TunnelHub {
  #children = new Map<string, ChildConnection>();

  get(name: string): ChildConnection | undefined {
    return this.#children.get(name);
  }

  names(): string[] {
    return [...this.#children.keys()];
  }

  /** A re-enrolling child replaces its previous connection. */
  attach(name: string, ws: WebSocket, registry: Registry): ChildConnection {
    this.#children.get(name)?.close();
    const conn = new ChildConnection(name, ws, registry, () => {
      if (this.#children.get(name) === conn) {
        this.#children.delete(name);
        // Only the CURRENT connection's death takes the child offline — a
        // replaced (stale) connection's async close must not mark a freshly
        // reattached child offline.
        registry.setOffline(name);
      }
    });
    this.#children.set(name, conn);
    return conn;
  }

  disconnect(name: string): void {
    this.#children.get(name)?.close();
  }
}
