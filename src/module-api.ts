import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import type { BrokerModuleApi, RouteHandler } from "../packages/module/src/index.js";
import type { BrokerEvents } from "./broker-events.js";
import type { Capability } from "./capabilities.js";
import { BrokerError } from "./errors.js";
import { git, repoCommit, repoDiff, repoLog, repoPush, repoTree, resolveRepo } from "./git-exec.js";
import { runBrokerMethod, type OpsDeps } from "./workspace-ops.js";

/** argv[0] values a module may not run through `raw`. These are the
 * operations whose broker equivalents audit and confirm — a module
 * wanting them goes through the vetted verb, which keeps the audit trail
 * and the preview hash intact.
 *
 * The denylist is on argv[0] only, and that is sufficient because `raw`
 * takes an ARRAY: there is no shell, so no second command can be
 * smuggled through a separator. */
const RAW_DENIED = new Set(["reset", "clean", "checkout", "rebase", "filter-branch", "gc", "prune"]);

function assertRawAllowed(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) {
    throw new BrokerError("bad_request", "git argv must be an array of strings — a string would need a shell");
  }
  if (argv.length === 0) throw new BrokerError("bad_request", "git argv must not be empty");
  if (RAW_DENIED.has(argv[0] as string)) {
    throw new BrokerError("bad_request", `git '${argv[0]}' is not permitted through raw — use the audited verb`);
  }
  if (argv[0] === "push" && argv.some((a) => a === "--force" || a === "-f")) {
    throw new BrokerError("bad_request", "git 'push --force' is not permitted through raw — use the audited verb");
  }
}

/** Resolves a module-supplied relative path inside a workspace, refusing
 * anything that leaves it.
 *
 * The guard walks up to the NEAREST EXISTING ancestor before calling
 * realpathSync, because realpathSync on a path that does not exist yet
 * proves nothing — and a module writing a new file is the common case.
 * Comparing `real + rest` against the resolved cwd with a `sep` boundary
 * is what stops both a symlinked parent and a sibling like `<cwd>-evil`. */
function resolveInWorkspace(cwd: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new BrokerError("bad_request", `path must be workspace-relative, got an absolute path: ${relPath}`);
  }
  const target = join(cwd, relPath);
  const realCwd = realpathSync(cwd);
  let probe = target;
  for (;;) {
    let real: string | undefined;
    try {
      real = realpathSync(probe);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) throw new BrokerError("bad_request", `path escapes the workspace: ${relPath}`);
      probe = parent;
      continue;
    }
    const resolved = real + target.slice(probe.length);
    if (resolved !== realCwd && !resolved.startsWith(realCwd + sep)) {
      throw new BrokerError("bad_request", `path escapes the workspace: ${relPath}`);
    }
    return resolved;
  }
}

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

  const cwdOf = (workspaceId: string): string => {
    const meta = opts.deps.index.get(opts.session, workspaceId);
    if (!meta) throw new BrokerError("unknown_workspace", `no recorded cwd for workspace '${workspaceId}'`);
    return meta.cwd;
  };

  if (has("files")) {
    api.files = {
      async read(workspaceId, relPath) {
        return readFileSync(resolveInWorkspace(cwdOf(workspaceId), relPath), "utf8");
      },
      async write(workspaceId, relPath, data, o) {
        const p = resolveInWorkspace(cwdOf(workspaceId), relPath);
        mkdirSync(dirname(p), { recursive: true });
        if (o?.append) appendFileSync(p, data);
        else writeFileSync(p, data);
      },
      async list(workspaceId, relDir) {
        return readdirSync(resolveInWorkspace(cwdOf(workspaceId), relDir));
      },
    };
  }

  if (has("git.read")) {
    const repoOf = (workspaceId: string, repo: string): string => resolveRepo(cwdOf(workspaceId), repo);
    api.git = {
      async raw(workspaceId, repo, argv) {
        assertRawAllowed(argv);
        // git() is git-exec's execFile-no-shell primitive with a hard
        // timeout; repoOf applies resolveRepo's path guard. A module
        // inherits both without knowing they exist.
        return git(repoOf(workspaceId, repo), argv);
      },
      async diff(workspaceId, repo, base) {
        return repoDiff(repoOf(workspaceId, repo), base);
      },
      async log(workspaceId, repo, limit) {
        return repoLog(repoOf(workspaceId, repo), limit);
      },
      async tree(workspaceId, repo) {
        return repoTree(repoOf(workspaceId, repo));
      },
    };
    if (has("git.write")) {
      api.git.commit = async (workspaceId, repo, message) =>
        repoCommit(repoOf(workspaceId, repo), { message, addAll: true });
      api.git.push = async (workspaceId, repo) => repoPush(repoOf(workspaceId, repo), {});
    }
  }

  if (has("workspaces")) {
    api.workspaces = {
      async list() {
        const r = (await runBrokerMethod(opts.deps, opts.session, "broker.workspace.list", {})) as {
          workspaces: Array<{ workspace_id: string; cwd: string; label?: string }>;
        };
        return r.workspaces;
      },
      async cwd(workspaceId) {
        return cwdOf(workspaceId);
      },
    };
  }

  if (has("agents")) {
    api.agents = {
      async list() {
        // There is no broker.agent.list — the HTTP route builds its
        // response in http.ts — so this reads herdr directly, the same
        // way resolveCwd and agentInPane do.
        const r = (await opts.deps.local.request(opts.session, "agent.list", {}, 10_000)) as {
          agents?: unknown[];
        };
        return r.agents ?? [];
      },
      async prompt(paneId, text) {
        return runBrokerMethod(opts.deps, opts.session, "broker.agent.prompt", { pane_id: paneId, text });
      },
      // Goes through runBrokerMethod, NOT askInner, so it takes the same
      // per-pane lock core takes. Two concurrent asks on one pane would
      // interleave two answer-file contracts at one agent, and the agent
      // cannot tell which prompt it is answering.
      async ask(paneId, prompt, o) {
        return runBrokerMethod(opts.deps, opts.session, "broker.agent.ask", {
          pane_id: paneId,
          prompt,
          ...(o?.timeoutMs ? { timeout_ms: o.timeoutMs } : {}),
        });
      },
    };
  }

  if (has("rpc")) {
    // The same herdr surface a federated child gets — modules do not
    // receive a wider one than the tunnel does.
    api.rpc = async (method, params) => opts.deps.local.request(opts.session, method, params, 30_000);
  }

  return { api, routes };
}
