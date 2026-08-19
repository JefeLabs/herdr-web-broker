import WebSocket from "ws";
import { BrokerError } from "./errors.js";
import type { LocalHerdr } from "./local-attach.js";
import { methodDenied } from "./policy.js";
import type { Registry } from "./registry.js";
import { HEARTBEAT_MS, PROTO_VERSION, type TunnelFrame } from "./tunnel.js";
import { PLUGIN_VERSION } from "./version.js";
import { isBrokerMethod, runBrokerMethod, type OpsDeps } from "./workspace-ops.js";

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;

/** Child side of the tunnel: dial out, enroll, answer, push, reconnect forever. */
export class ParentLink {
  #ws?: WebSocket;
  #attempt = 0;
  #stopped = false;
  #redial?: NodeJS.Timeout;
  #listeners: Array<() => void> = [];
  #missedPongs = 0;
  #heartbeat?: NodeJS.Timeout;

  constructor(
    private opts: {
      address: string;
      secret: string;
      name: string;
      local: LocalHerdr;
      registry: Registry;
      remoteDeny: string[];
      ops: OpsDeps;
    },
  ) {}

  start(): void {
    this.#stopped = false;
    this.#dial();
    const relay = (kind: "agent_status" | "session_added" | "session_removed") => {
      const listener = (e: { instance: string } & Record<string, unknown>) => {
        if (e.instance !== "runtime") return;
        if (kind === "agent_status") {
          this.#send({ type: "event", event: { kind, session: e.session as string, agent: e.agent as never } });
        } else if (kind === "session_added") {
          this.#send({ type: "event", event: { kind, session: e.session as never } });
        } else {
          this.#send({ type: "event", event: { kind, session: e.session as string } });
        }
      };
      this.opts.registry.on(kind, listener);
      this.#listeners.push(() => this.opts.registry.off(kind, listener));
    };
    relay("agent_status");
    relay("session_added");
    relay("session_removed");
  }

  #send(frame: TunnelFrame): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(frame));
  }

  #dial(): void {
    if (this.#stopped) return;
    const url = this.opts.address.replace(/\/$/, "") + "/parent/enroll";
    const ws = new WebSocket(url, {
      headers: {
        "x-herdr-broker-name": this.opts.name,
        "x-herdr-broker-secret": this.opts.secret,
      },
    });
    this.#ws = ws;
    ws.on("open", () => {
      // Spec §3: either side reaps a silently-dropped tunnel. The parent
      // already pings the child (ChildConnection); mirror that here.
      this.#missedPongs = 0;
      this.#heartbeat = setInterval(() => {
        this.#missedPongs += 1;
        if (this.#missedPongs > 2) {
          ws.terminate();
          return;
        }
        ws.ping();
      }, HEARTBEAT_MS);
      this.#heartbeat.unref();
      void this.opts.local.snapshot().then((snap) => {
        this.#send({
          type: "hello",
          name: this.opts.name,
          platform: snap.platform,
          herdr_version: snap.herdr_version,
          plugin_version: PLUGIN_VERSION,
          proto: PROTO_VERSION,
          sessions: snap.sessions,
        });
      });
    });
    ws.on("pong", () => (this.#missedPongs = 0));
    ws.on("message", (data) => {
      let frame: TunnelFrame;
      try {
        // An inbound frame must never crash the daemon.
        frame = JSON.parse(String(data)) as TunnelFrame;
      } catch {
        ws.close();
        return;
      }
      void this.#route(frame);
    });
    ws.on("close", () => {
      if (this.#heartbeat) clearInterval(this.#heartbeat);
      this.#scheduleRedial();
    });
    ws.on("error", () => ws.close());
  }

  async #route(frame: TunnelFrame): Promise<void> {
    if (frame.type === "welcome") {
      this.#attempt = 0;
      return;
    }
    if (frame.type !== "req") return;
    try {
      if (methodDenied(frame.method, this.opts.remoteDeny)) {
        throw new BrokerError("method_denied", `'${frame.method}' is denied for remote callers`);
      }
      const result = isBrokerMethod(frame.method)
        ? await runBrokerMethod(this.opts.ops, frame.session, frame.method, frame.params ?? {})
        : await this.opts.local.request(frame.session, frame.method, frame.params ?? {}, frame.timeout_ms);
      this.#send({ type: "res", id: frame.id, result });
    } catch (e) {
      const err = e instanceof BrokerError ? e : new BrokerError("upstream_error", String(e));
      this.#send({ type: "res", id: frame.id, error: { code: err.code, message: err.message } });
    }
  }

  #scheduleRedial(): void {
    if (this.#stopped) return;
    const base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_CAP_MS);
    this.#attempt += 1;
    const jitter = base * (0.8 + Math.random() * 0.4);
    this.#redial = setTimeout(() => this.#dial(), jitter);
    this.#redial.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#redial) clearTimeout(this.#redial);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    for (const off of this.#listeners) off();
    this.#listeners = [];
    this.#ws?.close();
  }
}
