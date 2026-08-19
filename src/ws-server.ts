import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { verifySecret } from "./auth.js";
import type { BrokerConfig } from "./config.js";
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
      // Task 10 wires the client duplex; until then: not found.
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      void clientWss;
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
