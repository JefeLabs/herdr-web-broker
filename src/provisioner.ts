import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { BrokerError } from "./errors.js";
import type { HerdrEndpoint } from "./local-attach.js";

export interface SessionProvisioner {
  start(name: string): Promise<HerdrEndpoint>;
  stop(name: string): Promise<void>;
}

/** Real provisioner (spec 2026-08-22): one `herdr server --session <name>`
 * per owned session. start() is idempotent — an already-listening socket is
 * adopted, not respawned; stop() uses herdr's own lifecycle verbs.
 * Structural invariant: only the `u-` namespace under sessionsDir is ever
 * addressed, so the primary herdr (default socket, hosting this API
 * plugin) is untouchable by construction, not just by check. */
export class HerdrProvisioner implements SessionProvisioner {
  constructor(
    private opts: { sessionsDir: string; logDir: string; bin?: string; timeoutMs?: number },
  ) {}

  #bin(): string {
    return this.opts.bin ?? process.env.HERDR_BIN_PATH ?? "herdr";
  }

  #guard(name: string): void {
    if (!name.startsWith("u-") || name.includes("/") || name.includes("..")) {
      throw new BrokerError("bad_request", "provisioned sessions live in the u- namespace only");
    }
  }

  async start(name: string): Promise<HerdrEndpoint> {
    this.#guard(name);
    const socketPath = join(this.opts.sessionsDir, name, "herdr.sock");
    if (!existsSync(socketPath)) {
      mkdirSync(this.opts.logDir, { recursive: true });
      const log = openSync(join(this.opts.logDir, `herdr-${name}.log`), "a");
      const child = spawn(this.#bin(), ["server", "--session", name], {
        detached: true,
        stdio: ["ignore", log, log],
      });
      child.on("error", () => undefined); // missing binary surfaces as the timeout below
      child.unref();
    }
    const deadline = Date.now() + (this.opts.timeoutMs ?? 15_000);
    while (!existsSync(socketPath)) {
      if (Date.now() > deadline) {
        throw new BrokerError("provision_failed", `herdr session '${name}' produced no socket in time`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { session: name, socketPath };
  }

  async stop(name: string): Promise<void> {
    this.#guard(name);
    spawnSync(this.#bin(), ["session", "stop", name], { timeout: 15_000 });
    spawnSync(this.#bin(), ["session", "delete", name], { timeout: 15_000 });
  }
}
