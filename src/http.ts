import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkBearer, hashSecret, mintSecret } from "./auth.js";
import type { BrokerConfig } from "./config.js";
import { BrokerError, httpStatus } from "./errors.js";
import { LocalHerdr, mapAgentList } from "./local-attach.js";
import { methodDenied } from "./policy.js";
import type { Registry } from "./registry.js";
import type { ChildrenStore } from "./state.js";
import type { TunnelHub } from "./tunnel.js";
import { PLUGIN_VERSION } from "./version.js";
import type { CallInstance } from "./ws-server.js";
import { isBrokerMethod, runBrokerMethod, type OpsDeps } from "./workspace-ops.js";

export interface HttpDeps {
  registry: Registry;
  local: LocalHerdr;
  hub: TunnelHub;
  children: ChildrenStore;
  config: BrokerConfig;
  adminToken: string;
  ops: OpsDeps;
  onReload?: () => void;
}

export function makeCallInstance(deps: {
  registry: Registry;
  local: LocalHerdr;
  hub: TunnelHub;
  remoteDeny: string[];
  ops: OpsDeps;
}): CallInstance {
  return async (instance, session, method, params, timeoutMs) => {
    if (instance === "runtime") {
      if (!deps.local.sessions().includes(session)) {
        throw new BrokerError("unknown_session", `runtime has no session '${session}'`);
      }
      if (isBrokerMethod(method)) return runBrokerMethod(deps.ops, session, method, params);
      return deps.local.request(session, method, params, timeoutMs);
    }
    // Parent-side fast-fail per spec §2 — deny without touching the tunnel.
    // The child re-enforces its own policy authoritatively (spec §4).
    if (methodDenied(method, deps.remoteDeny)) {
      throw new BrokerError("method_denied", `'${method}' is denied for remote-originated calls`);
    }
    const entry = deps.registry.get(instance);
    if (!entry) throw new BrokerError("unknown_instance", `no instance '${instance}'`);
    const child = deps.hub.get(instance);
    if (!child) {
      throw new BrokerError("instance_offline", `'${instance}' is not connected`, {
        last_seen: entry.as_of,
      });
    }
    if (!(session in entry.sessions)) {
      throw new BrokerError("unknown_session", `'${instance}' has no session '${session}'`);
    }
    return child.request(session, method, params, timeoutMs);
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, e: unknown): void {
  const err = e instanceof BrokerError ? e : new BrokerError("upstream_error", String(e));
  try {
    json(res, httpStatus(err.code), err.toEnvelope());
  } catch {
    // The socket may already be destroyed (e.g. body-cap abort) — a failed
    // error write must not crash the daemon.
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_048_576) {
      // Leftover unread bytes on the wire desync the next keep-alive
      // request's framing — abort the connection outright, not just the read.
      req.socket.destroy();
      throw new BrokerError("bad_request", "body exceeds 1MB");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new BrokerError("bad_request", "body is not valid JSON");
  }
}

export function createHttpHandler(deps: HttpDeps) {
  const callInstance = makeCallInstance({
    registry: deps.registry,
    local: deps.local,
    hub: deps.hub,
    remoteDeny: deps.config.policy.remote_deny,
    ops: deps.ops,
  });

  return (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res).catch((e) => fail(res, e));
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, name: "herdr-web-broker", version: PLUGIN_VERSION, pid: process.pid });
      return;
    }

    if (parts[0] === "admin") {
      const remote = req.socket.remoteAddress ?? "";
      const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      // Constant-time compare so token length/content never leaks via timing.
      const presented = String(req.headers["x-admin-token"] ?? "");
      const tokenOk = timingSafeEqual(
        createHash("sha256").update(presented).digest(),
        createHash("sha256").update(deps.adminToken).digest(),
      );
      if (!loopback || !tokenOk) {
        throw new BrokerError("unauthorized", "admin requires loopback + x-admin-token");
      }
      await admin(req, res, parts, url);
      return;
    }

    // Auth is checked before route existence so an unauthenticated caller
    // learns nothing about which routes exist (401, never a route's 404).
    if (!checkBearer(req.headers.authorization, deps.config.client_tokens)) {
      throw new BrokerError("unauthorized", "missing or invalid bearer token");
    }
    if (parts[0] !== "parent") {
      throw new BrokerError("unknown_instance", `no route ${url.pathname}`);
    }

    // GET /parent
    if (parts.length === 1 && req.method === "GET") {
      json(res, 200, { instances: deps.registry.rollup() });
      return;
    }

    const instance = decodeURIComponent(parts[1] ?? "");
    const entry = deps.registry.get(instance);
    if (!entry) throw new BrokerError("unknown_instance", `no instance '${instance}'`);

    // GET /parent/{i}
    if (parts.length === 2 && req.method === "GET") {
      json(res, 200, {
        instance,
        online: entry.online,
        as_of: entry.as_of,
        platform: entry.platform,
        herdr_version: entry.herdr_version,
        counts: deps.registry.counts(instance),
        sessions: Object.keys(entry.sessions),
      });
      return;
    }

    // POST/GET /parent/{i}/env, DELETE /parent/{i}/env/{name} — env registry
    // (env spec §3). Instance-scoped: any live session carries the transport.
    if (parts[2] === "env") {
      const transport = Object.keys(entry.sessions)[0];
      if (!transport) throw new BrokerError("unknown_session", `'${instance}' has no sessions to carry env ops`);
      if (parts.length === 3 && req.method === "POST") {
        const body = await readBody(req);
        json(res, 200, (await callInstance(instance, transport, "broker.env.set", body)) as Record<string, unknown>);
        return;
      }
      if (parts.length === 3 && req.method === "GET") {
        json(res, 200, (await callInstance(instance, transport, "broker.env.list", {})) as Record<string, unknown>);
        return;
      }
      if (parts.length === 4 && req.method === "DELETE") {
        const params: Record<string, unknown> = { name: decodeURIComponent(parts[3]) };
        const kind = url.searchParams.get("kind");
        if (kind !== null) params.kind = kind;
        const sess = url.searchParams.get("session");
        if (sess !== null) params.session = sess;
        json(res, 200, (await callInstance(instance, transport, "broker.env.delete", params)) as Record<string, unknown>);
        return;
      }
    }

    // GET /parent/{i}/models[?kind=] — model catalog (builtin + config),
    // instance-scoped like /env: any live session carries the transport.
    if (parts.length === 3 && parts[2] === "models" && req.method === "GET") {
      const transport = Object.keys(entry.sessions)[0];
      if (!transport) throw new BrokerError("unknown_session", `'${instance}' has no sessions to carry model ops`);
      const kind = url.searchParams.get("kind");
      const params = kind === null ? {} : { kind };
      json(res, 200, (await callInstance(instance, transport, "broker.models.list", params)) as Record<string, unknown>);
      return;
    }

    // GET /parent/{i}/sessions
    if (parts.length === 3 && parts[2] === "sessions" && req.method === "GET") {
      const sessions = Object.entries(entry.sessions).map(([name, sess]) => {
        const counts = { working: 0, blocked: 0, idle: 0 };
        for (const agent of sess.agents) counts[agent.status] += 1;
        return { name, counts };
      });
      json(res, 200, { sessions });
      return;
    }

    const session = decodeURIComponent(parts[3] ?? "");
    if (parts[2] !== "sessions" || !(session in entry.sessions)) {
      throw new BrokerError("unknown_session", `'${instance}' has no session '${session}'`);
    }

    // GET /parent/{i}/sessions/{s}/agents
    if (parts[4] === "agents" && req.method === "GET") {
      let agents = entry.sessions[session].agents;
      if (url.searchParams.get("fresh") === "1") {
        agents = mapAgentList(await callInstance(instance, session, "agent.list", {}));
        deps.registry.applySessionAdded(instance, { name: session, agents });
      }
      json(res, 200, { instance, session, online: entry.online, as_of: entry.as_of, agents });
      return;
    }

    // POST /parent/{i}/sessions/{s}/agents — spawn a team agent (spec §2.1)
    if (parts.length === 5 && parts[4] === "agents" && req.method === "POST") {
      const body = await readBody(req);
      // Clamp before it reaches setTimeout anywhere downstream — an
      // unclamped value overflows Node's 32-bit timer delay and fires
      // ~immediately instead of after the requested wait.
      const t = Math.min(Math.max(typeof body.timeout_ms === "number" ? body.timeout_ms : 30_000, 1_000), 600_000);
      body.timeout_ms = t;
      const result = await callInstance(instance, session, "broker.agent.spawn", body, t + 30_000);
      json(res, 201, result as Record<string, unknown>);
      return;
    }

    // GET /parent/{i}/sessions/{s}/workspaces — working sets (spec §2.2)
    if (parts.length === 5 && parts[4] === "workspaces" && req.method === "GET") {
      json(res, 200, await callInstance(instance, session, "broker.workspace.list", {}));
      return;
    }

    // GET .../workspaces/{w}/repos/{r}/tree (spec §2.3)
    if (parts.length === 9 && parts[4] === "workspaces" && parts[6] === "repos" && parts[8] === "tree" && req.method === "GET") {
      const params = { workspace_id: decodeURIComponent(parts[5]), repo: decodeURIComponent(parts[7]) };
      json(res, 200, await callInstance(instance, session, "broker.repo.tree", params));
      return;
    }

    // GET .../workspaces/{w}/repos/{r}/git/diff?base=<ref> (spec §2.4)
    if (
      parts.length === 10 && parts[4] === "workspaces" && parts[6] === "repos" &&
      parts[8] === "git" && parts[9] === "diff" && req.method === "GET"
    ) {
      const params: Record<string, unknown> = {
        workspace_id: decodeURIComponent(parts[5]),
        repo: decodeURIComponent(parts[7]),
      };
      const base = url.searchParams.get("base");
      if (base !== null) params.base = base;
      json(res, 200, await callInstance(instance, session, "broker.repo.diff", params));
      return;
    }

    // POST .../agents/{pane}/ask — structured answer via file-drop (spec §2.5)
    if (parts.length === 7 && parts[4] === "agents" && parts[6] === "ask" && req.method === "POST") {
      const body = await readBody(req);
      const t = Math.min(Math.max(typeof body.timeout_ms === "number" ? body.timeout_ms : 120_000, 1_000), 600_000);
      body.timeout_ms = t;
      const params = { ...body, pane_id: decodeURIComponent(parts[5]) };
      json(res, 200, await callInstance(instance, session, "broker.agent.ask", params, t + 45_000));
      return;
    }

    // POST .../agents/{pane}/model — switch a running agent's model by
    // typing its CLI's own model command into the pane
    if (parts.length === 7 && parts[4] === "agents" && parts[6] === "model" && req.method === "POST") {
      const body = await readBody(req);
      const params = { ...body, pane_id: decodeURIComponent(parts[5]) };
      json(res, 200, await callInstance(instance, session, "broker.agent.model", params));
      return;
    }

    // POST /parent/{i}/sessions/{s}/rpc
    if (parts[4] === "rpc" && req.method === "POST") {
      const body = await readBody(req);
      const method = body.method;
      if (typeof method !== "string" || method.length === 0) {
        throw new BrokerError("bad_request", "rpc body needs a string 'method'");
      }
      const timeout = typeof body.timeout_ms === "number" ? body.timeout_ms : undefined;
      const result = await callInstance(instance, session, method, body.params ?? {}, timeout);
      json(res, 200, { result });
      return;
    }

    throw new BrokerError("bad_request", `unsupported route ${req.method} ${url.pathname}`);
  }

  async function admin(
    req: IncomingMessage,
    res: ServerResponse,
    parts: string[],
    url: URL,
  ): Promise<void> {
    if (req.method === "GET" && parts[1] === "status") {
      json(res, 200, {
        listen: deps.config.listen,
        instances: deps.registry.rollup(),
        children: deps.children.names(),
      });
      return;
    }
    if (req.method === "POST" && parts[1] === "children" && parts.length === 2) {
      const body = await readBody(req);
      const name = body.name;
      if (typeof name !== "string" || !/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new BrokerError("bad_request", "child name must be [a-zA-Z0-9._-]+");
      }
      const secret = mintSecret();
      deps.children.set(name, hashSecret(secret));
      json(res, 200, { name, secret });
      return;
    }
    if (req.method === "DELETE" && parts[1] === "children" && parts.length === 3) {
      const name = decodeURIComponent(parts[2]);
      deps.children.delete(name);
      deps.hub.disconnect(name);
      json(res, 200, { revoked: name });
      return;
    }
    if (req.method === "POST" && parts[1] === "reload") {
      deps.onReload?.();
      json(res, 200, { reloaded: true });
      return;
    }
    throw new BrokerError("bad_request", `unsupported admin route ${req.method} ${url.pathname}`);
  }
}
