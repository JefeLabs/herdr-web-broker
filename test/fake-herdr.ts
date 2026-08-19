import { createServer, type Server, type Socket } from "node:net";
import { encodeFrame, NdjsonDecoder } from "../src/ndjson.js";

interface Frame {
  id?: string;
  method?: string;
  params?: unknown;
}

/** Throw from a handler to make the fake answer a real-shaped error frame
 * (herdr 0.8.0 replies {id, error: {code, message}} and closes, same as a
 * success). */
export class FakeHerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Real-shaped herdr agent entry (herdr 0.8.0 agent.list vocabulary). */
export interface FakeAgent {
  pane_id: string;
  name: string;
  agent_status: string;
  [extra: string]: unknown;
}

/** Stand-in for a herdr 0.8.0 server socket, mirroring its REAL connection
 * semantics (validated against the binary): every request is one-shot — the
 * server replies once and closes the connection — EXCEPT events.subscribe,
 * which converts the connection into a persistent event-only channel that
 * receives { event, data } frames via emitEvent(). */
export class FakeHerdr {
  agents: FakeAgent[] = [];
  received: { method: string; params: unknown }[] = [];
  handlers = new Map<string, (params: unknown) => unknown>();
  #server: Server;
  #conns = new Set<Socket>();
  #eventConns = new Set<Socket>();

  constructor(readonly socketPath: string) {
    this.handlers.set("ping", () => ({ type: "pong", version: "0.8.0-test", protocol: 19 }));
    this.handlers.set("agent.list", () => ({ type: "agent_list", agents: this.agents }));
    this.#server = createServer((sock) => {
      this.#conns.add(sock);
      const dec = new NdjsonDecoder();
      sock.on("data", (chunk) => {
        for (const frame of dec.push(chunk)) this.#handle(sock, frame as Frame);
      });
      sock.on("close", () => {
        this.#conns.delete(sock);
        this.#eventConns.delete(sock);
      });
      sock.on("error", () => {
        this.#conns.delete(sock);
        this.#eventConns.delete(sock);
      });
    });
  }

  #handle(sock: Socket, frame: Frame): void {
    if (!frame.method) return;
    this.received.push({ method: frame.method, params: frame.params });
    if (frame.method === "events.subscribe") {
      this.#eventConns.add(sock);
      sock.write(encodeFrame({ id: frame.id, result: { type: "subscription_started" } }));
      return; // connection stays open as an event channel
    }
    const handler = this.handlers.get(frame.method);
    if (handler) {
      try {
        sock.write(encodeFrame({ id: frame.id, result: handler(frame.params) }));
      } catch (e) {
        const code = e instanceof FakeHerdrError ? e.code : "internal_error";
        sock.write(encodeFrame({ id: frame.id, error: { code, message: String((e as Error).message ?? e) } }));
      }
    } else
      sock.write(
        encodeFrame({
          id: frame.id,
          error: { code: "not_found", message: `unknown method ${frame.method}` },
        }),
      );
    sock.end(); // one-shot: real herdr closes after the reply
  }

  /** Streams a real-shaped event frame to every subscribed channel. */
  emitEvent(event: string, data: object): void {
    for (const sock of this.#eventConns) sock.write(encodeFrame({ event, data }));
  }

  /** Writes raw bytes to every subscribed event channel — simulates a
   * malformed or truncated line arriving from the herdr side. */
  sendRaw(data: string): void {
    for (const sock of this.#eventConns) sock.write(data);
  }

  get connections(): number {
    return this.#conns.size;
  }

  get eventConnections(): number {
    return this.#eventConns.size;
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.#server.listen(this.socketPath, resolve));
  }

  close(): Promise<void> {
    for (const sock of this.#conns) sock.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}
