import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { BrokerError } from "./errors.js";
import { encodeFrame, NdjsonDecoder } from "./ndjson.js";
import { methodDenied } from "./policy.js";
import type { Registry } from "./registry.js";
import type { TunnelHub } from "./tunnel.js";

/** Materializes each online remote session as a local herdr-NDJSON socket so
 * the stock herdr CLI can drive remote machines via HERDR_SOCKET_PATH (spec §7).
 * Unix-only in v1; a no-op on Windows. */
export class Projection {
  #servers = new Map<string, Server>(); // key: `${instance}/${session}`
  #listeners: Array<() => void> = [];

  constructor(private opts: { dir: string; hub: TunnelHub; registry: Registry; remoteDeny: string[] }) {}

  start(): void {
    if (process.platform === "win32") return;
    const sync = (e: { instance: string }) => this.#syncInstance(e.instance);
    const drop = (e: { instance: string }) => this.#removeInstance(e.instance);
    const dropSession = (e: { instance: string; session: string }) =>
      this.#removeSocket(e.instance, e.session);
    this.opts.registry.on("snapshot", sync);
    this.opts.registry.on("session_added", sync);
    this.opts.registry.on("session_removed", dropSession);
    this.opts.registry.on("offline", drop);
    this.#listeners.push(
      () => this.opts.registry.off("snapshot", sync),
      () => this.opts.registry.off("session_added", sync),
      () => this.opts.registry.off("session_removed", dropSession),
      () => this.opts.registry.off("offline", drop),
    );
    for (const instance of this.opts.registry.instances()) this.#syncInstance(instance);
  }

  #syncInstance(instance: string): void {
    if (instance === "runtime") return;
    const entry = this.opts.registry.get(instance);
    if (!entry?.online) return;
    for (const session of Object.keys(entry.sessions)) this.#ensureSocket(instance, session);
  }

  #ensureSocket(instance: string, session: string): void {
    const key = `${instance}/${session}`;
    if (this.#servers.has(key)) return;
    const dir = join(this.opts.dir, instance);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${session}.sock`);
    rmSync(path, { force: true });
    const server = createServer((sock) => {
      const dec = new NdjsonDecoder();
      sock.on("data", (chunk) => {
        let frames: unknown[];
        try {
          frames = dec.push(chunk);
        } catch {
          // An inbound local client must never crash the daemon: a malformed
          // line closes just this connection, not the projected socket.
          sock.destroy();
          return;
        }
        for (const raw of frames) {
          const frame = raw as { id?: string; method?: string; params?: unknown };
          if (typeof frame.method !== "string") {
            sock.write(
              encodeFrame({
                id: frame.id,
                error: { code: "bad_request", message: "frame needs a string 'method'" },
              }),
            );
            continue;
          }
          // Parent-side fast-fail per spec §2, same as REST/WS — the child
          // re-enforces its own policy authoritatively (spec §4).
          if (methodDenied(frame.method, this.opts.remoteDeny)) {
            sock.write(
              encodeFrame({
                id: frame.id,
                error: {
                  code: "method_denied",
                  message: `'${frame.method}' is denied for remote-originated calls`,
                },
              }),
            );
            continue;
          }
          const child = this.opts.hub.get(instance);
          const call = child
            ? child.request(session, frame.method, frame.params ?? {})
            : Promise.reject(new BrokerError("instance_offline", `'${instance}' is not connected`));
          void call
            .then((result) => sock.write(encodeFrame({ id: frame.id, result })))
            .catch((e: BrokerError) =>
              sock.write(
                encodeFrame({ id: frame.id, error: { code: e.code ?? "upstream_error", message: e.message } }),
              ),
            );
        }
      });
      sock.on("error", () => sock.destroy());
    });
    server.listen(path);
    this.#servers.set(key, server);
  }

  #removeSocket(instance: string, session: string): void {
    const key = `${instance}/${session}`;
    const server = this.#servers.get(key);
    if (!server) return;
    this.#servers.delete(key);
    server.close();
    rmSync(join(this.opts.dir, instance, `${session}.sock`), { force: true });
  }

  #removeInstance(instance: string): void {
    for (const key of [...this.#servers.keys()]) {
      if (key.startsWith(`${instance}/`)) {
        this.#removeSocket(instance, key.slice(instance.length + 1));
      }
    }
  }

  stop(): void {
    for (const off of this.#listeners) off();
    this.#listeners = [];
    for (const key of [...this.#servers.keys()]) {
      const [instance, session] = key.split("/");
      this.#removeSocket(instance, session);
    }
  }
}
