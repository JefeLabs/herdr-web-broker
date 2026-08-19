import { createServer, type Server, type Socket } from "node:net";
import { encodeFrame, NdjsonDecoder } from "../src/ndjson.js";
import type { AgentInfo } from "../src/registry.js";

interface Frame {
  id?: string;
  method?: string;
  params?: unknown;
}

/** Minimal stand-in for a herdr server socket: NDJSON request/response with
 * canned handlers, plus emitEvent() to stream event frames to every client. */
export class FakeHerdr {
  agents: AgentInfo[] = [];
  received: { method: string; params: unknown }[] = [];
  handlers = new Map<string, (params: unknown) => unknown>();
  #server: Server;
  #conns = new Set<Socket>();

  constructor(readonly socketPath: string) {
    this.handlers.set("ping", () => ({ type: "pong" }));
    this.handlers.set("agent.list", () => ({ agents: this.agents }));
    this.handlers.set("events.subscribe", () => ({ subscribed: true }));
    this.#server = createServer((sock) => {
      this.#conns.add(sock);
      const dec = new NdjsonDecoder();
      sock.on("data", (chunk) => {
        for (const frame of dec.push(chunk)) this.#handle(sock, frame as Frame);
      });
      sock.on("close", () => this.#conns.delete(sock));
      sock.on("error", () => this.#conns.delete(sock));
    });
  }

  #handle(sock: Socket, frame: Frame): void {
    if (!frame.method) return;
    this.received.push({ method: frame.method, params: frame.params });
    const handler = this.handlers.get(frame.method);
    if (handler) sock.write(encodeFrame({ id: frame.id, result: handler(frame.params) }));
    else
      sock.write(
        encodeFrame({
          id: frame.id,
          error: { code: "not_found", message: `unknown method ${frame.method}` },
        }),
      );
  }

  emitEvent(event: object): void {
    for (const sock of this.#conns) sock.write(encodeFrame({ event }));
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.#server.listen(this.socketPath, resolve));
  }

  close(): Promise<void> {
    for (const sock of this.#conns) sock.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}
