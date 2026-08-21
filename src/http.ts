import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkBearer, hashSecret, matchToken, mintSecret } from "./auth.js";
import { AuthLimiter } from "./auth-limit.js";
import type { Audit } from "./audit.js";
import type { Presence } from "./presence.js";
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
  /** invoked after admin token revocation mutates config.client_tokens —
   * the daemon persists the new set to config.toml */
  onTokensChanged?: () => void;
  /** who is using the instance (opt-in identity via POST /parent/auth) */
  presence: Presence;
  /** terminates live WS sockets authed with the token; returns how many */
  onKickSockets?: (tokenName: string) => number;
  /** failed-auth limiter shared with the WS upgrade path (default: built in) */
  limiter?: AuthLimiter;
  /** append-only trail of privileged actions (admin ops + env writes) */
  audit?: Audit;
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

/** Raw upload reader for context attachments — binary-safe, capped. */
async function readRawBody(req: IncomingMessage, capBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > capBytes) {
      req.socket.destroy();
      throw new BrokerError("bad_request", `body exceeds ${Math.round(capBytes / (1024 * 1024))}MB`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
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
  const limiter = deps.limiter ?? new AuthLimiter();
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

    // Everything below /health authenticates; a rate-limited address is
    // refused before any token comparison happens.
    const remoteIp = req.socket.remoteAddress ?? "unknown";
    if (limiter.blocked(remoteIp)) {
      throw new BrokerError("rate_limited", "too many failed auth attempts — wait and retry");
    }

    if (parts[0] === "admin") {
      const loopback = remoteIp === "127.0.0.1" || remoteIp === "::1" || remoteIp === "::ffff:127.0.0.1";
      // Constant-time compare so token length/content never leaks via timing.
      const presented = String(req.headers["x-admin-token"] ?? "");
      const tokenOk = timingSafeEqual(
        createHash("sha256").update(presented).digest(),
        createHash("sha256").update(deps.adminToken).digest(),
      );
      if (!loopback || !tokenOk) {
        // Only a PRESENTED credential counts as an attempt — credential-less
        // requests probe nothing, and counting them would let an
        // unauthenticated SPA lock its own user out.
        if (presented) limiter.record(remoteIp);
        throw new BrokerError("unauthorized", "admin requires loopback + x-admin-token");
      }
      limiter.success(remoteIp);
      await admin(req, res, parts, url);
      return;
    }

    // Auth is checked before route existence so an unauthenticated caller
    // learns nothing about which routes exist (401, never a route's 404).
    const tokenName = matchToken(req.headers.authorization, deps.config.client_tokens);
    if (tokenName === undefined) {
      // count only real credential attempts (see the admin branch note)
      if (req.headers.authorization?.startsWith("Bearer ") && req.headers.authorization.length > 7) {
        limiter.record(remoteIp);
      }
      throw new BrokerError("unauthorized", "missing or invalid bearer token");
    }
    limiter.success(remoteIp);
    deps.presence.touch(tokenName);
    if (parts[0] !== "parent") {
      throw new BrokerError("unknown_instance", `no route ${url.pathname}`);
    }

    // GET /parent
    if (parts.length === 1 && req.method === "GET") {
      json(res, 200, { instances: deps.registry.rollup(), in_use_by: deps.presence.list() });
      return;
    }

    // POST /parent/auth — opt-in identity: who is using this instance.
    // ("auth" is therefore a reserved instance name.)
    if (parts.length === 2 && parts[1] === "auth" && req.method === "POST") {
      const body = await readBody(req);
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 64) : undefined;
      const email = typeof body.email === "string" ? body.email.trim().slice(0, 128) : undefined;
      if (email !== undefined && email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new BrokerError("bad_request", "'email' must look like an email address");
      }
      json(res, 200, deps.presence.identify(tokenName, { ...(name ? { name } : {}), ...(email ? { email } : {}) }));
      return;
    }

    // DELETE /parent/auth — self-eviction: the presented token kicks
    // ITSELF (revoked + persisted, WS sockets closed, presence cleared).
    // Safe without admin — you can only evict the token you hold. Agent
    // panes are untouched; that stays the admin kick's hammer.
    if (parts.length === 2 && parts[1] === "auth" && req.method === "DELETE") {
      const remaining = deps.config.client_tokens.filter((t) => t.name !== tokenName);
      const tokenRevoked = remaining.length !== deps.config.client_tokens.length;
      if (tokenRevoked) {
        deps.config.client_tokens = remaining;
        deps.onTokensChanged?.();
      }
      const socketsClosed = deps.onKickSockets?.(tokenName) ?? 0;
      deps.presence.remove(tokenName);
      deps.audit?.record({
        action: "auth.self_kick",
        actor: tokenName,
        remote: req.socket.remoteAddress ?? undefined,
      });
      json(res, 200, { signed_out: tokenName, token_revoked: tokenRevoked, sockets_closed: socketsClosed });
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
        const result = (await callInstance(instance, transport, "broker.env.set", body)) as Record<string, unknown>;
        // credentials changed hands — that belongs in the trail, keyed to the bearer
        deps.audit?.record({
          action: "env.set",
          actor: tokenName,
          target: typeof body.name === "string" ? body.name : undefined,
          remote: req.socket.remoteAddress ?? undefined,
        });
        json(res, 200, result);
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
        const result = (await callInstance(instance, transport, "broker.env.delete", params)) as Record<string, unknown>;
        deps.audit?.record({
          action: "env.delete",
          actor: tokenName,
          target: String(params.name),
          remote: req.socket.remoteAddress ?? undefined,
        });
        json(res, 200, result);
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

    // DELETE .../agents/{pane} — stop the agent by closing its pane
    if (parts.length === 6 && parts[4] === "agents" && req.method === "DELETE") {
      const params = { pane_id: decodeURIComponent(parts[5]) };
      json(res, 200, await callInstance(instance, session, "broker.agent.stop", params));
      return;
    }

    // GET /parent/{i}/sessions/{s}/workspaces — working sets (spec §2.2)
    if (parts.length === 5 && parts[4] === "workspaces" && req.method === "GET") {
      json(res, 200, await callInstance(instance, session, "broker.workspace.list", {}));
      return;
    }

    // DELETE .../workspaces/{w} — close the workspace and every pane in it
    if (parts.length === 6 && parts[4] === "workspaces" && req.method === "DELETE") {
      const params = { workspace_id: decodeURIComponent(parts[5]) };
      json(res, 200, await callInstance(instance, session, "broker.workspace.close", params));
      return;
    }

    // GET .../workspaces/{w}/repos/{r}/tree (spec §2.3)
    if (parts.length === 9 && parts[4] === "workspaces" && parts[6] === "repos" && parts[8] === "tree" && req.method === "GET") {
      const params = { workspace_id: decodeURIComponent(parts[5]), repo: decodeURIComponent(parts[7]) };
      json(res, 200, await callInstance(instance, session, "broker.repo.tree", params));
      return;
    }

    // GET .../workspaces/{w}/repos/{r}/file?path= — raw file contents
    if (parts.length === 9 && parts[4] === "workspaces" && parts[6] === "repos" && parts[8] === "file" && req.method === "GET") {
      const params = {
        workspace_id: decodeURIComponent(parts[5]),
        repo: decodeURIComponent(parts[7]),
        path: url.searchParams.get("path") ?? "",
      };
      json(res, 200, await callInstance(instance, session, "broker.repo.file", params));
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

    // Workspace context attachments: uploads the agent should read (PDFs,
    // images…), stored under .herdr/context/ outside the repos; ACTIVE
    // attachments are listed in every prompt/ask/spec text automatically.
    if (parts.length === 7 && parts[4] === "workspaces" && parts[6] === "context" && req.method === "GET") {
      const params = { workspace_id: decodeURIComponent(parts[5]) };
      json(res, 200, await callInstance(instance, session, "broker.context.list", params));
      return;
    }
    if (parts.length === 8 && parts[4] === "workspaces" && parts[6] === "context") {
      const base = { workspace_id: decodeURIComponent(parts[5]), name: decodeURIComponent(parts[7]) };
      if (req.method === "PUT") {
        const content = await readRawBody(req, 8 * 1024 * 1024);
        const params: Record<string, unknown> = {
          ...base,
          content_b64: content.toString("base64"),
          content_type: req.headers["content-type"] ?? "application/octet-stream",
        };
        if (url.searchParams.get("active") === "0") params.active = false;
        json(res, 201, await callInstance(instance, session, "broker.context.put", params, 60_000));
        return;
      }
      if (req.method === "GET") {
        const got = (await callInstance(instance, session, "broker.context.get", base)) as {
          content_b64: string;
          content_type: string;
        };
        const buf = Buffer.from(got.content_b64, "base64");
        res.writeHead(200, { "content-type": got.content_type, "content-length": buf.length });
        res.end(buf);
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        json(res, 200, await callInstance(instance, session, "broker.context.set", { ...base, active: body.active }));
        return;
      }
      if (req.method === "DELETE") {
        json(res, 200, await callInstance(instance, session, "broker.context.delete", base));
        return;
      }
    }

    // Basic git verbs (the vibe-coding loop): commit / log / push / checkout
    if (parts.length === 10 && parts[4] === "workspaces" && parts[6] === "repos" && parts[8] === "git") {
      const verb = parts[9];
      const base = { workspace_id: decodeURIComponent(parts[5]), repo: decodeURIComponent(parts[7]) };
      if (verb === "log" && req.method === "GET") {
        const limitRaw = url.searchParams.get("limit");
        const params: Record<string, unknown> = { ...base };
        if (limitRaw !== null) params.limit = Number(limitRaw) || 20;
        json(res, 200, await callInstance(instance, session, "broker.repo.log", params));
        return;
      }
      if ((verb === "commit" || verb === "push" || verb === "checkout") && req.method === "POST") {
        const body = await readBody(req);
        json(res, 200, await callInstance(instance, session, `broker.repo.${verb}`, { ...body, ...base }, 90_000));
        return;
      }
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

    // POST .../agents/{pane}/prompt — fire-and-forget steering: a free-form
    // prompt to the same agent, no reply contract (ask is the structured twin)
    if (parts.length === 7 && parts[4] === "agents" && parts[6] === "prompt" && req.method === "POST") {
      const body = await readBody(req);
      const params = { ...body, pane_id: decodeURIComponent(parts[5]) };
      json(res, 200, await callInstance(instance, session, "broker.agent.prompt", params));
      return;
    }

    // POST .../agents/{pane}/slash/{command} — type the CLI's own slash
    // command into the pane; optional single-line {args} in the body
    if (parts.length === 8 && parts[4] === "agents" && parts[6] === "slash" && req.method === "POST") {
      const body = await readBody(req);
      const params = {
        ...body,
        pane_id: decodeURIComponent(parts[5]),
        command: decodeURIComponent(parts[7]),
      };
      json(res, 200, await callInstance(instance, session, "broker.agent.slash", params));
      return;
    }

    // Spec bundles — a directory of design files an agent maintains.
    // POST .../agents/{pane}/spec-bundles            create/continue + prompt
    // POST .../agents/{pane}/spec-bundles/{b}/plan   ask for plan.md
    // GET  .../workspaces/{w}/spec-bundles           list
    // GET  .../workspaces/{w}/spec-bundles/{b}?version=&wait_ms=  pull/long-poll
    if (parts.length === 7 && parts[4] === "agents" && parts[6] === "spec-bundles" && req.method === "POST") {
      const body = await readBody(req);
      const params = { ...body, pane_id: decodeURIComponent(parts[5]) };
      json(res, 201, await callInstance(instance, session, "broker.spec.drive", params, 45_000));
      return;
    }
    if (
      parts.length === 9 && parts[4] === "agents" && parts[6] === "spec-bundles" &&
      parts[8] === "plan" && req.method === "POST"
    ) {
      const body = await readBody(req);
      const params = {
        ...body,
        pane_id: decodeURIComponent(parts[5]),
        bundle: decodeURIComponent(parts[7]),
      };
      json(res, 200, await callInstance(instance, session, "broker.spec.plan", params, 45_000));
      return;
    }
    if (parts.length === 7 && parts[4] === "workspaces" && parts[6] === "spec-bundles" && req.method === "GET") {
      const params = { workspace_id: decodeURIComponent(parts[5]) };
      json(res, 200, await callInstance(instance, session, "broker.spec.list", params));
      return;
    }
    if (parts.length === 8 && parts[4] === "workspaces" && parts[6] === "spec-bundles" && req.method === "GET") {
      const params: Record<string, unknown> = {
        workspace_id: decodeURIComponent(parts[5]),
        bundle: decodeURIComponent(parts[7]),
      };
      const version = url.searchParams.get("version");
      if (version !== null) params.version = version;
      const waitRaw = url.searchParams.get("wait_ms");
      const waitMs = waitRaw === null ? 0 : Math.min(Math.max(Number(waitRaw) || 0, 0), 30_000);
      if (waitMs > 0) params.wait_ms = waitMs;
      json(res, 200, await callInstance(instance, session, "broker.spec.get", params, waitMs + 15_000));
      return;
    }

    // Live pane viewer — the terminal screen as data.
    // GET .../panes/{pane}/screen?source=&version=&wait_ms=  pull/long-poll
    if (parts.length === 7 && parts[4] === "panes" && parts[6] === "screen" && req.method === "GET") {
      const params: Record<string, unknown> = { pane_id: decodeURIComponent(parts[5]) };
      const source = url.searchParams.get("source");
      if (source !== null) params.source = source;
      const version = url.searchParams.get("version");
      if (version !== null) params.version = version;
      const waitRaw = url.searchParams.get("wait_ms");
      const waitMs = waitRaw === null ? 0 : Math.min(Math.max(Number(waitRaw) || 0, 0), 30_000);
      if (waitMs > 0) params.wait_ms = waitMs;
      json(res, 200, await callInstance(instance, session, "broker.pane.screen", params, waitMs + 15_000));
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
    const note = (action: string, target?: string) =>
      deps.audit?.record({ action, actor: "admin", target, remote: req.socket.remoteAddress ?? undefined });
    if (req.method === "GET" && parts[1] === "status") {
      json(res, 200, {
        listen: deps.config.listen,
        instances: deps.registry.rollup(),
        children: deps.children.names(),
        in_use_by: deps.presence.list(),
      });
      return;
    }
    // POST /admin/kick/{tokenName} — full eviction: revoke the token
    // (immediate + persisted), terminate their live WS sockets, type
    // /logout into matching agent panes, clear presence.
    if (req.method === "POST" && parts[1] === "kick" && parts.length === 3) {
      const name = decodeURIComponent(parts[2]);
      const body = await readBody(req);
      const remaining = deps.config.client_tokens.filter((t) => t.name !== name);
      const tokenRevoked = remaining.length !== deps.config.client_tokens.length;
      const known = tokenRevoked || deps.presence.list().some((e) => e.token === name);
      if (!known) throw new BrokerError("unknown_token", `no client token or presence named '${name}'`);
      if (tokenRevoked) {
        deps.config.client_tokens = remaining;
        deps.onTokensChanged?.();
      }
      const socketsClosed = deps.onKickSockets?.(name) ?? 0;
      const kinds = Array.isArray(body.kinds) ? body.kinds.map(String) : ["copilot"];
      const loggedOut: string[] = [];
      if (body.logout_agents !== false) {
        for (const session of deps.local.sessions()) {
          const raw = (await deps.local
            .request(session, "agent.list", {}, 10_000)
            .catch(() => ({}))) as { agents?: Array<Record<string, unknown>> };
          for (const a of raw.agents ?? []) {
            if (typeof a.pane_id !== "string" || !kinds.includes(String(a.agent ?? ""))) continue;
            await deps.local
              .request(session, "pane.send_input", { pane_id: a.pane_id, text: "/logout", keys: ["Enter"] }, 10_000)
              .then(() => loggedOut.push(a.pane_id as string))
              .catch(() => undefined); // a dead pane must not abort the eviction
          }
        }
      }
      deps.presence.remove(name);
      note("kick", name);
      json(res, 200, {
        kicked: name,
        token_revoked: tokenRevoked,
        sockets_closed: socketsClosed,
        logged_out_panes: loggedOut,
      });
      return;
    }
    // POST /admin/tokens — dev-environment token generator. Off by default;
    // [token_mint] enabled = true turns it on (dev configs, the demo stack).
    if (req.method === "POST" && parts[1] === "tokens" && parts.length === 2) {
      if (!deps.config.token_mint.enabled) {
        throw new BrokerError("mint_disabled", "token minting is disabled — set [token_mint] enabled = true (dev only)");
      }
      const body = await readBody(req);
      const name = body.name;
      if (typeof name !== "string" || !/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new BrokerError("bad_request", "token name must be [a-zA-Z0-9._-]+");
      }
      if (deps.config.client_tokens.some((t) => t.name === name)) {
        throw new BrokerError("bad_request", `token name '${name}' already exists — names are the revocation key`);
      }
      const token = mintSecret();
      // show-once: only the hash is stored — this response is the one place
      // the plaintext ever exists
      deps.config.client_tokens.push({ name, token_hash: hashSecret(token) });
      deps.onTokensChanged?.();
      note("token.mint", name);
      json(res, 200, { name, token });
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
      note("child.mint", name);
      json(res, 200, { name, secret });
      return;
    }
    if (req.method === "DELETE" && parts[1] === "children" && parts.length === 3) {
      const name = decodeURIComponent(parts[2]);
      deps.children.delete(name);
      deps.hub.disconnect(name);
      note("child.revoke", name);
      json(res, 200, { revoked: name });
      return;
    }
    // DELETE /admin/tokens/{name} — revoke a client token: immediate for new
    // requests and WS upgrades (both auth checks read this same config
    // object), persisted via onTokensChanged. Already-open WS sockets are
    // not tracked per token and stay up until they close.
    if (req.method === "DELETE" && parts[1] === "tokens" && parts.length === 3) {
      const name = decodeURIComponent(parts[2]);
      const remaining = deps.config.client_tokens.filter((t) => t.name !== name);
      if (remaining.length === deps.config.client_tokens.length) {
        throw new BrokerError("unknown_token", `no client token named '${name}'`);
      }
      deps.config.client_tokens = remaining;
      deps.onTokensChanged?.();
      note("token.revoke", name);
      json(res, 200, { revoked: name, remaining: remaining.length });
      return;
    }
    // GET /admin/audit?limit= — the trail's tail, oldest first
    if (req.method === "GET" && parts[1] === "audit" && parts.length === 2) {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 1000);
      json(res, 200, { entries: deps.audit?.tail(limit) ?? [] });
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
