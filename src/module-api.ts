import type { BrokerModuleApi, RouteHandler } from "../packages/module/src/index.js";
import type { BrokerEvents } from "./broker-events.js";
import type { Capability } from "./capabilities.js";
import { BrokerError } from "./errors.js";
import type { OpsDeps } from "./workspace-ops.js";

export interface RegisteredRoute {
  method: string;
  path: string;
  handler: RouteHandler;
}

export interface BuildApiOpts {
  moduleId: string;
  granted: Capability[];
  deps: OpsDeps;
  session: string;
  instance: string;
  events: BrokerEvents;
  log: (msg: string) => void;
  audit: { record(e: { action: string; actor: string; target?: string }): void };
}

export interface BuiltApi {
  api: BrokerModuleApi;
  routes: RegisteredRoute[];
}

/** Constructs a module's `api` FROM ITS GRANT.
 *
 * This is the single place "capabilities, not internals" is enforced, and
 * it should stay reviewable in one sitting — if it grows past that, the
 * growth is the bug. Nothing here ever hands a module `OpsDeps`, raw
 * `node:fs`, or a child process; every capability wraps a helper that
 * already carries the broker's guarantees.
 *
 * An ungranted capability is never assigned, so it is `undefined` on the
 * object rather than a stub that throws. A module using one fails at its
 * first call with a TypeError naming the missing property — at the
 * author's load test, not in production. */
export function buildApi(opts: BuildApiOpts): BuiltApi {
  const routes: RegisteredRoute[] = [];
  const has = (c: Capability): boolean => opts.granted.includes(c);

  const api: BrokerModuleApi = {
    route(method, path, handler) {
      if (!path.startsWith("/")) throw new Error(`route path must start with '/': ${path}`);
      if (path.includes("..")) throw new Error(`route path may not contain '..': ${path}`);
      routes.push({ method, path, handler });
    },
    log(msg, extra) {
      opts.log(`[module ${opts.moduleId}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}`);
    },
    audit(action, target) {
      // The `module:` prefix keeps these distinguishable from the human
      // and token actors already in the trail.
      opts.audit.record({ action, actor: `module:${opts.moduleId}`, ...(target ? { target } : {}) });
    },
    badRequest: (msg) => new BrokerError("bad_request", msg),
    notFound: (msg) => new BrokerError("unknown_workspace", msg),
  };

  // Capabilities are ASSIGNED behind their guard, never stubbed.
  void has;

  return { api, routes };
}
