import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { checkBearer, matchToken, verifySecret } from "./auth.js";
import type { AuthLimiter } from "./auth-limit.js";
import type { BrokerConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import type { LocalHerdr } from "./local-attach.js";
import type { Registry } from "./registry.js";
import type { ChildrenStore } from "./state.js";
import { PROTO_VERSION, TunnelHub, type TunnelFrame } from "./tunnel.js";

export type CallInstance = (
  instance: string,
  session: string,
  method: string,
  params: unknown,
  timeoutMs?: number,
) => Promise<unknown>;

export interface WsDeps {
  children: ChildrenStore;
  hub: TunnelHub;
  registry: Registry;
  config: BrokerConfig;
  callInstance?: CallInstance;
  /** client-socket keepalive interval; intermediaries (nginx etc.) cull
   * idle sockets, so the server pings rather than every deployment tuning
   * its proxy */
  pingIntervalMs?: number;
  /** failed-auth limiter shared with the HTTP surface */
  limiter?: AuthLimiter;
  /** event passthrough: taps for runtime subscriptions (spec 2026-08-21) */
  local?: LocalHerdr;
}

/** The 27 wire-verified herdr subscription types (schema, protocol 19). */
const SUB_TYPES = new Set([
  "workspace.created", "workspace.updated", "workspace.metadata_updated", "workspace.renamed",
  "workspace.moved", "workspace.reordered", "workspace.closed", "workspace.focused",
  "worktree.created", "worktree.opened", "worktree.removed",
  "tab.created", "tab.closed", "tab.focused", "tab.renamed", "tab.moved",
  "pane.created", "pane.closed", "pane.updated", "pane.focused", "pane.moved", "pane.exited",
  "pane.agent_detected", "pane.output_matched", "pane.agent_status_changed", "pane.scroll_changed",
  "layout.updated",
]);
const SUB_KEYS = new Set(["type", "pane_id", "match", "source", "lines", "strip_ansi", "agent_status"]);
const MAX_SUB_GROUPS = 8;
const MAX_SUB_TYPES = 32;

function sanitizeSubscriptions(raw: unknown): object[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SUB_TYPES) {
    throw new BrokerError("bad_request", `'subscriptions' must be a non-empty array of at most ${MAX_SUB_TYPES}`);
  }
  return raw.map((s) => {
    const sub = s as Record<string, unknown>;
    if (!sub || typeof sub.type !== "string" || !SUB_TYPES.has(sub.type)) {
      throw new BrokerError("bad_request", `unknown subscription type '${String(sub?.type)}'`);
    }
    // pass through only the schema's parameter keys — nothing smuggles
    return Object.fromEntries(Object.entries(sub).filter(([k]) => SUB_KEYS.has(k)));
  });
}

export interface UpgradeHandle {
  /** Terminates every currently-connected /enroll and /events
   * client. http.Server's own closeAllConnections() does not reach these —
   * a socket handed off via the 'upgrade' event is no longer tracked as an
   * HTTP connection, only as a ws WebSocketServer client. */
  closeAllConnections(): void;
  /** Terminates the client sockets that authed with the named token
   * (kickout); returns how many were closed. */
  closeToken(tokenName: string): number;
}

export function attachUpgradeHandling(server: Server, deps: WsDeps): UpgradeHandle {
  const enrollWss = new WebSocketServer({ noServer: true });
  // Clients may offer ["bearer", <token>] as subprotocols; the server always
  // selects the literal "bearer" so the token itself is never echoed back.
  const clientWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("bearer") ? "bearer" : false),
  });

  // Keepalive: ping every interval; a socket that missed the previous pong
  // is dead and gets terminated instead of lingering.
  const alive = new WeakMap<WebSocket, boolean>();
  // Which token authed each client socket — the kickout key.
  const socketToken = new WeakMap<WebSocket, string>();
  const pinger = setInterval(() => {
    for (const ws of clientWss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, deps.pingIntervalMs ?? 30_000);
  pinger.unref();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reqUrl = new URL(req.url ?? "/", "http://placeholder");
    const path = reqUrl.pathname;
    if (path === "/enroll") {
      const name = String(req.headers["x-herdr-broker-name"] ?? "");
      const secret = String(req.headers["x-herdr-broker-secret"] ?? "");
      const child = deps.children.get(name);
      if (!name || !child || !verifySecret(secret, child.secret_hash)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      enrollWss.handleUpgrade(req, socket, head, (ws) => acceptChild(deps, name, ws));
    } else if (path === "/events") {
      // Same failed-auth limiter as HTTP: an address hammering the upgrade
      // path gets 429 before any token comparison.
      const remoteIp = req.socket.remoteAddress ?? "unknown";
      if (deps.limiter?.blocked(remoteIp)) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        socket.destroy();
        return;
      }
      // Browsers cannot set an Authorization header on WebSocket upgrades.
      // Preferred alternative: offer ["bearer", <token>] as subprotocols —
      // the token rides a header, not the URL. ?token= is also accepted as
      // a fallback, with the documented caveat that query strings land in
      // access logs, so deployments keeping it should scrub the param at
      // their proxy.
      const offered = String(req.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== "bearer");
      const queryToken = reqUrl.searchParams.get("token");
      const candidates = [
        req.headers.authorization,
        ...offered.map((t) => `Bearer ${t}`),
        ...(queryToken !== null ? [`Bearer ${queryToken}`] : []),
      ];
      let matched: string | undefined;
      for (const c of candidates) {
        matched = matchToken(c, deps.config.client_tokens);
        if (matched !== undefined) break;
      }
      if (matched === undefined) {
        // count only upgrades that actually offered a credential
        if (candidates.some((c) => typeof c === "string" && c.length > "Bearer ".length)) {
          deps.limiter?.record(remoteIp);
        }
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      deps.limiter?.success(remoteIp);
      const tokenName = matched;
      clientWss.handleUpgrade(req, socket, head, (ws) => {
        alive.set(ws, true);
        socketToken.set(ws, tokenName);
        ws.on("pong", () => alive.set(ws, true));
        acceptClient(deps, ws);
      });
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  return {
    closeAllConnections() {
      clearInterval(pinger);
      for (const ws of enrollWss.clients) ws.terminate();
      for (const ws of clientWss.clients) ws.terminate();
    },
    closeToken(tokenName: string): number {
      let closed = 0;
      for (const ws of clientWss.clients) {
        if (socketToken.get(ws) === tokenName) {
          ws.terminate();
          closed++;
        }
      }
      return closed;
    },
  };
}

function acceptChild(deps: WsDeps, name: string, ws: WebSocket): void {
  const timer = setTimeout(() => ws.close(4000, "hello timeout"), 5000);
  ws.once("message", (data) => {
    clearTimeout(timer);
    let hello: TunnelFrame;
    try {
      // An inbound frame must never crash the daemon.
      hello = JSON.parse(String(data)) as TunnelFrame;
    } catch {
      ws.close(4000, "bad hello");
      return;
    }
    if (hello.type !== "hello") {
      ws.close(4000, "bad hello");
      return;
    }
    if (hello.proto !== PROTO_VERSION) {
      ws.close(4001, "proto_mismatch");
      return;
    }
    // The enrolled (secret-bound) name is authoritative; hello.name is informational.
    deps.registry.replaceSnapshot(name, {
      platform: hello.platform,
      herdr_version: hello.herdr_version,
      sessions: hello.sessions,
    });
    deps.hub.attach(name, ws, deps.registry);
    ws.send(JSON.stringify({ type: "welcome", name, proto: PROTO_VERSION }));
  });
}

function acceptClient(deps: WsDeps, ws: WebSocket): void {
  const push = (event: Record<string, unknown>) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event }));
  };
  const onStatus = (e: { instance: string; session: string; agent: unknown }) =>
    push({ type: "agent_status", instance: e.instance, session: e.session, agent: e.agent });
  const onOnline = (e: { instance: string }) => push({ type: "instance.online", instance: e.instance });
  const onOffline = (e: { instance: string }) => push({ type: "instance.offline", instance: e.instance });
  deps.registry.on("agent_status", onStatus);
  deps.registry.on("online", onOnline);
  deps.registry.on("offline", onOffline);
  // event passthrough: live taps for this socket, torn down with it
  const taps = new Map<string, () => void>();
  let subSeq = 0;
  ws.on("close", () => {
    deps.registry.off("agent_status", onStatus);
    deps.registry.off("online", onOnline);
    deps.registry.off("offline", onOffline);
    for (const close of taps.values()) close();
    taps.clear();
  });

  async function subscribeFrame(frame: { instance?: string; session?: string; params?: unknown }): Promise<unknown> {
    const instance = String(frame.instance ?? "");
    const session = String(frame.session ?? "");
    if (!instance || !session) throw new BrokerError("bad_request", "subscribe needs 'instance' and 'session'");
    const subscriptions = sanitizeSubscriptions((frame.params as { subscriptions?: unknown })?.subscriptions);
    if (taps.size >= MAX_SUB_GROUPS) {
      throw new BrokerError("bad_request", `at most ${MAX_SUB_GROUPS} live subscription groups per socket`);
    }
    const subId = `sub-${++subSeq}`;
    const handlers = {
      onEvent: (name: string, data: unknown) =>
        push({ type: "herdr_event", sub_id: subId, instance, session, name, data }),
      onClose: (reason: string) => {
        taps.delete(subId);
        push({ type: "sub_closed", sub_id: subId, reason });
      },
    };
    // reserve the slot BEFORE awaiting — concurrent subscribes must not
    // all pass the cap check while none has landed yet
    taps.set(subId, () => undefined);
    try {
      let close: () => void;
      if (instance === "runtime") {
        if (!deps.local) throw new BrokerError("bad_request", "event passthrough unavailable");
        close = await deps.local.tap(session, subscriptions, handlers);
      } else {
        const child = deps.hub.get(instance);
        if (!child) throw new BrokerError("instance_offline", `'${instance}' is not connected`);
        close = await child.subscribe(session, subscriptions, handlers);
      }
      if (!taps.has(subId)) {
        // torn down while the ack was in flight (socket closed)
        close();
      } else {
        taps.set(subId, close);
      }
    } catch (e) {
      taps.delete(subId);
      throw e;
    }
    return { sub_id: subId };
  }

  ws.on("message", (data) => {
    void (async () => {
      let id: unknown;
      try {
        const frame = JSON.parse(String(data)) as {
          id?: unknown;
          instance?: string;
          session?: string;
          method?: string;
          params?: unknown;
          timeout_ms?: number;
        };
        id = frame.id;
        if (typeof frame.method !== "string") {
          throw new BrokerError("bad_request", "frame needs a string 'method'");
        }
        if (frame.method === "events.subscribe") {
          ws.send(JSON.stringify({ id, result: { subscribed: true } }));
          return;
        }
        if (frame.method === "broker.events.subscribe") {
          ws.send(JSON.stringify({ id, result: await subscribeFrame(frame) }));
          return;
        }
        if (frame.method === "broker.events.unsubscribe") {
          const subId = String((frame.params as { sub_id?: unknown })?.sub_id ?? "");
          const close = taps.get(subId);
          if (!close) throw new BrokerError("bad_request", `no live subscription '${subId}'`);
          taps.delete(subId);
          close();
          ws.send(JSON.stringify({ id, result: { unsubscribed: true } }));
          return;
        }
        if (!deps.callInstance) throw new BrokerError("bad_request", "rpc unavailable");
        const result = await deps.callInstance(
          String(frame.instance ?? ""),
          String(frame.session ?? ""),
          frame.method,
          frame.params ?? {},
          frame.timeout_ms,
        );
        ws.send(JSON.stringify({ id, result }));
      } catch (e) {
        const err = e instanceof BrokerError ? e : new BrokerError("upstream_error", String(e));
        ws.send(JSON.stringify({ id, error: err.toEnvelope() }));
      }
    })();
  });
}
