import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { checkBearer, verifySecret } from "./auth.js";
import type { BrokerConfig } from "./config.js";
import { BrokerError } from "./errors.js";
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
}

export function attachUpgradeHandling(server: Server, deps: WsDeps): void {
  const enrollWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://placeholder").pathname;
    if (path === "/parent/enroll") {
      const name = String(req.headers["x-herdr-broker-name"] ?? "");
      const secret = String(req.headers["x-herdr-broker-secret"] ?? "");
      const child = deps.children.get(name);
      if (!name || !child || !verifySecret(secret, child.secret_hash)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      enrollWss.handleUpgrade(req, socket, head, (ws) => acceptChild(deps, name, ws));
    } else if (path === "/parent/ws") {
      if (!checkBearer(req.headers.authorization, deps.config.client_tokens)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      clientWss.handleUpgrade(req, socket, head, (ws) => acceptClient(deps, ws));
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });
}

function acceptChild(deps: WsDeps, name: string, ws: WebSocket): void {
  const timer = setTimeout(() => ws.close(4000, "hello timeout"), 5000);
  ws.once("message", (data) => {
    clearTimeout(timer);
    const hello = JSON.parse(String(data)) as TunnelFrame;
    if (hello.type !== "hello" || hello.proto !== PROTO_VERSION) {
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
  ws.on("close", () => {
    deps.registry.off("agent_status", onStatus);
    deps.registry.off("online", onOnline);
    deps.registry.off("offline", onOffline);
  });

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
