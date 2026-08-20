import { BrokerApiError, BrokerNetworkError } from "./errors.js";

export type WsFactory = (url: string, protocols: string[]) => WebSocket;

export type EventType =
  | "agent_status"
  | "instance_online"
  | "instance_offline"
  | "open"
  | "close"
  /** the token was rejected (revoked/kicked) — reconnecting stopped; fix
   * the token and call connect() again */
  | "auth_failed";

export interface EventChannelOpts {
  origin: string;
  /** read at (re)connect time so setToken() applies to reconnects */
  token: () => string;
  wsFactory?: WsFactory;
  /** used by the pre-reconnect auth probe; defaults to global fetch */
  fetchFn?: typeof fetch;
}

/** WS /parent/ws: unsolicited status events plus duplex rpc frames on one
 * socket. Auth rides the ["bearer", <token>] subprotocols (never the URL);
 * unclean closes reconnect with jittered exponential backoff. */
export class EventChannel {
  #opts: EventChannelOpts;
  #ws?: WebSocket;
  #wanted = false;
  #attempts = 0;
  #nextId = 1;
  #reconnect?: ReturnType<typeof setTimeout>;
  #subs = new Map<EventType, Set<(data: unknown) => void>>();
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  constructor(opts: EventChannelOpts) {
    this.#opts = opts;
  }

  connect(): void {
    if (this.#wanted) return;
    this.#wanted = true;
    this.#open();
  }

  close(): void {
    this.#wanted = false;
    clearTimeout(this.#reconnect);
    this.#ws?.close();
    this.#ws = undefined;
  }

  on(type: EventType, cb: (data: unknown) => void): () => void {
    let set = this.#subs.get(type);
    if (!set) this.#subs.set(type, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  rpc(instance: string, session: string, method: string, params: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== 1) {
        reject(new BrokerNetworkError("event socket not open"));
        return;
      }
      const id = String(this.#nextId++);
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, instance, session, method, params, timeout_ms: timeoutMs }));
    });
  }

  #emit(type: EventType, data: unknown): void {
    for (const cb of this.#subs.get(type) ?? []) cb(data);
  }

  #open(): void {
    const url = this.#opts.origin.replace(/^http/, "ws") + "/parent/ws";
    const factory = this.#opts.wsFactory ?? ((u: string, p: string[]) => new WebSocket(u, p));
    const ws = factory(url, ["bearer", this.#opts.token()]);
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempts = 0;
      this.#emit("open", undefined);
    };
    ws.onmessage = (ev) => this.#onFrame(String((ev as MessageEvent).data));
    ws.onclose = (ev) => {
      const clean = !this.#wanted || Boolean((ev as CloseEvent).wasClean);
      this.#emit("close", { clean });
      for (const p of this.#pending.values()) p.reject(new BrokerNetworkError("event socket closed"));
      this.#pending.clear();
      if (this.#wanted) void this.#maybeReconnect();
    };
  }

  /** Browsers hide the HTTP status of a failed upgrade, so before each
   * reconnect a cheap authed probe asks whether the token is still alive:
   * 401 means revoked/kicked — stop and emit auth_failed rather than
   * retrying forever. Network failures keep the retry loop going (an
   * outage is not an eviction). */
  async #maybeReconnect(): Promise<void> {
    try {
      const res = await (this.#opts.fetchFn ?? fetch)(this.#opts.origin + "/parent", {
        headers: { authorization: `Bearer ${this.#opts.token()}` },
      });
      if (res.status === 401) {
        this.#wanted = false;
        this.#emit("auth_failed", undefined);
        return;
      }
    } catch {
      // broker unreachable — keep retrying on the normal backoff
    }
    if (!this.#wanted) return;
    const delay = Math.min(1_000 * 2 ** this.#attempts++, 30_000) + Math.floor(Math.random() * 250);
    this.#reconnect = setTimeout(() => this.#open(), delay);
  }

  #onFrame(text: string): void {
    let frame: {
      event?: { type?: unknown; [k: string]: unknown };
      id?: unknown;
      result?: unknown;
      error?: { code?: string; message?: string; [k: string]: unknown };
    };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return; // a malformed frame must never break the channel
    }
    if (frame.event) {
      const type = String(frame.event.type ?? "").replace(".", "_");
      if (type === "agent_status" || type === "instance_online" || type === "instance_offline") {
        this.#emit(type, frame.event);
      }
      return;
    }
    if (frame.id !== undefined) {
      const pending = this.#pending.get(String(frame.id));
      if (!pending) return;
      this.#pending.delete(String(frame.id));
      if (frame.error) {
        const { code, message, ...details } = frame.error;
        pending.reject(new BrokerApiError(code ?? "ws_error", message ?? "ws rpc failed", 0, details));
      } else {
        pending.resolve(frame.result);
      }
    }
  }
}
