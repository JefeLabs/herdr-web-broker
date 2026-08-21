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

export interface SubscriptionSpec {
  /** herdr subscription type, e.g. "pane.created" */
  type: string;
  [k: string]: unknown;
}

export interface SubscribeTarget {
  instance: string;
  session: string;
  subscriptions: SubscriptionSpec[];
}

interface SubGroup {
  target: SubscribeTarget;
  onEvent: (name: string, data: unknown) => void;
  onClose?: (reason: string) => void;
  subId?: string;
}

export interface EventChannelOpts {
  origin: string;
  /** read at (re)connect time so setToken() applies to reconnects */
  token: () => string;
  wsFactory?: WsFactory;
  /** used by the pre-reconnect auth probe; defaults to global fetch */
  fetchFn?: typeof fetch;
}

/** WS /events: unsolicited status events plus duplex rpc frames on one
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
  #groups = new Set<SubGroup>();
  #bySubId = new Map<string, SubGroup>();

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

  /** Event passthrough: stream a herdr instance's own events (pane.created,
   * agent status, output matches, …) through the broker. Resolves with an
   * unsubscribe fn once the broker acks. The group survives reconnects —
   * the channel re-subscribes on its own under a fresh sub_id; a
   * server-side closure (tap died, child offline) reaches onClose and
   * retires the group. */
  async subscribe(
    target: SubscribeTarget,
    onEvent: (name: string, data: unknown) => void,
    onClose?: (reason: string) => void,
  ): Promise<() => void> {
    const group: SubGroup = { target, onEvent, onClose };
    await this.#sendSubscribe(group);
    this.#groups.add(group);
    this.#bySubId.set(group.subId!, group);
    return () => {
      if (!this.#groups.delete(group)) return;
      if (group.subId) this.#bySubId.delete(group.subId);
      if (this.#ws?.readyState === 1 && group.subId) {
        void this.rpc(target.instance, target.session, "broker.events.unsubscribe", { sub_id: group.subId }).catch(
          () => undefined,
        );
      }
    };
  }

  async #sendSubscribe(group: SubGroup): Promise<void> {
    const { instance, session, subscriptions } = group.target;
    const result = (await this.rpc(instance, session, "broker.events.subscribe", { subscriptions })) as {
      sub_id: string;
    };
    group.subId = result.sub_id;
  }

  #resubscribeAll(): void {
    for (const group of this.#groups) {
      if (group.subId) this.#bySubId.delete(group.subId);
      group.subId = undefined;
      void this.#sendSubscribe(group)
        .then(() => {
          if (this.#groups.has(group)) this.#bySubId.set(group.subId!, group);
        })
        .catch((e: unknown) => {
          // the broker refused the re-subscribe (caps, revoked session) —
          // retire the group honestly instead of retrying forever
          this.#groups.delete(group);
          group.onClose?.(e instanceof Error ? e.message : "resubscribe failed");
        });
    }
  }

  #emit(type: EventType, data: unknown): void {
    for (const cb of this.#subs.get(type) ?? []) cb(data);
  }

  #open(): void {
    const url = this.#opts.origin.replace(/^http/, "ws") + "/events";
    const factory = this.#opts.wsFactory ?? ((u: string, p: string[]) => new WebSocket(u, p));
    const ws = factory(url, ["bearer", this.#opts.token()]);
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempts = 0;
      this.#emit("open", undefined);
      this.#resubscribeAll();
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
      const res = await (this.#opts.fetchFn ?? fetch)(this.#opts.origin + "/instances", {
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
      if (frame.event.type === "herdr_event") {
        const e = frame.event as { sub_id?: string; name?: string; data?: unknown };
        this.#bySubId.get(String(e.sub_id))?.onEvent(String(e.name), e.data);
        return;
      }
      if (frame.event.type === "sub_closed") {
        const e = frame.event as { sub_id?: string; reason?: string };
        const group = this.#bySubId.get(String(e.sub_id));
        if (group) {
          this.#bySubId.delete(String(e.sub_id));
          this.#groups.delete(group);
          group.onClose?.(String(e.reason ?? "subscription closed"));
        }
        return;
      }
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
