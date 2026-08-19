import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BrokerError } from "./errors.js";
import { discoverRepos, repoDiff, repoTree, resolveRepo } from "./git-exec.js";
import type { LocalHerdr } from "./local-attach.js";
import type { Registry } from "./registry.js";
import type { WorkspaceIndex } from "./state.js";

export interface OpsDeps {
  local: LocalHerdr;
  registry: Registry;
  index: WorkspaceIndex;
  /** test overrides for broker.agent.ask pacing */
  askPollMs?: number;
  askGraceMs?: number;
}

export function isBrokerMethod(method: string): boolean {
  return method.startsWith("broker.");
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new BrokerError("bad_request", `'${name}' must be a non-empty string`);
  }
  return v;
}

/** Virtual methods run on the instance that owns the disk — the same
 * dispatch is reached from makeCallInstance (runtime) and ParentLink
 * (child side of the tunnel). Spec §3. */
export async function runBrokerMethod(
  deps: OpsDeps,
  session: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!deps.local.sessions().includes(session)) {
    throw new BrokerError("unknown_session", `no local session '${session}'`);
  }
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "broker.workspace.list":
      return listWorkspaces(deps, session);
    case "broker.repo.tree": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      const repo = str(p.repo, "repo");
      const cwd = await resolveCwd(deps, session, workspaceId);
      return { workspace_id: workspaceId, repo, ...(await repoTree(resolveRepo(cwd, repo))) };
    }
    case "broker.repo.diff": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      const repo = str(p.repo, "repo");
      const base = p.base === undefined ? undefined : str(p.base, "base");
      const cwd = await resolveCwd(deps, session, workspaceId);
      return { workspace_id: workspaceId, repo, ...(await repoDiff(resolveRepo(cwd, repo), base)) };
    }
    case "broker.agent.spawn":
      return spawn(deps, session, p);
    case "broker.agent.ask":
      return ask(deps, session, p);
    default:
      throw new BrokerError("bad_request", `unknown broker method '${method}'`);
  }
}

interface HerdrWorkspace {
  cwd?: string;
  label?: string;
}

/** Opportunistic herdr workspace.list (spec §4 primary source): if herdr
 * 0.8.0 lacks the method or reports no cwd, this degrades to an empty map
 * and the WorkspaceIndex is the source of truth. One code path either way. */
async function herdrWorkspaces(deps: OpsDeps, session: string): Promise<Map<string, HerdrWorkspace>> {
  const out = new Map<string, HerdrWorkspace>();
  const res = (await deps.local.request(session, "workspace.list", {}, 5000).catch(() => undefined)) as
    | { workspaces?: Array<Record<string, unknown>> }
    | undefined;
  if (Array.isArray(res?.workspaces)) {
    for (const w of res.workspaces) {
      if (typeof w.workspace_id !== "string") continue;
      out.set(w.workspace_id, {
        cwd: typeof w.cwd === "string" ? w.cwd : undefined,
        label: typeof w.label === "string" ? w.label : undefined,
      });
    }
  }
  return out;
}

async function resolveCwd(deps: OpsDeps, session: string, workspaceId: string): Promise<string> {
  const cwd = (await herdrWorkspaces(deps, session)).get(workspaceId)?.cwd ?? deps.index.get(session, workspaceId)?.cwd;
  if (!cwd) {
    throw new BrokerError(
      "unknown_workspace",
      `no recorded cwd for workspace '${workspaceId}' — spawn via the API or upgrade herdr`,
    );
  }
  return cwd;
}

function foldStatus(s: unknown): "working" | "blocked" | "idle" {
  return s === "working" || s === "blocked" ? s : "idle";
}

async function listWorkspaces(deps: OpsDeps, session: string): Promise<unknown> {
  const fromHerdr = await herdrWorkspaces(deps, session);
  const raw = (await deps.local.request(session, "agent.list", {}, 10_000).catch(() => ({}))) as {
    agents?: Array<Record<string, unknown>>;
  };
  const agentsByWs = new Map<string, { agent: string; pane_id: string; status: string }[]>();
  for (const a of raw.agents ?? []) {
    const pane = typeof a.pane_id === "string" ? a.pane_id : "";
    if (!pane.includes(":")) continue;
    const ws = pane.split(":")[0];
    const list = agentsByWs.get(ws) ?? [];
    list.push({
      agent: String(a.name ?? a.agent ?? "agent"),
      pane_id: pane,
      status: foldStatus(a.agent_status),
    });
    agentsByWs.set(ws, list);
  }
  const indexed = deps.index.all(session);
  const ids = [...new Set([...fromHerdr.keys(), ...agentsByWs.keys(), ...Object.keys(indexed)])].sort();
  const workspaces = [];
  for (const id of ids) {
    const cwd = fromHerdr.get(id)?.cwd ?? indexed[id]?.cwd ?? null;
    const label = fromHerdr.get(id)?.label ?? indexed[id]?.label;
    workspaces.push({
      workspace_id: id,
      cwd,
      ...(label ? { label } : {}),
      agents: agentsByWs.get(id) ?? [],
      repos: cwd ? await discoverRepos(cwd) : [],
    });
  }
  return { workspaces };
}

/** Mode A (cwd): create a new working set + first team member. Mode B
 * (workspace_id): grow the team — spec §8.2 fallback, a new workspace with
 * the same cwd and inherited label, since herdr 0.8.0's pane-create method
 * is unverified. args go verbatim to agent.start (model/effort flags live
 * there — the broker never interprets them). */
async function spawn(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const kind = str(p.kind, "kind");
  const hasCwd = typeof p.cwd === "string";
  const hasWs = typeof p.workspace_id === "string";
  if (hasCwd === hasWs) {
    throw new BrokerError("bad_request", "exactly one of 'cwd' and 'workspace_id' is required");
  }
  let args: string[] | undefined;
  if (p.args !== undefined) {
    if (!Array.isArray(p.args) || !p.args.every((a) => typeof a === "string" && a.length <= 256)) {
      throw new BrokerError("bad_request", "'args' must be an array of strings of at most 256 chars each");
    }
    args = p.args as string[];
  }
  let cwd: string;
  let label = typeof p.label === "string" ? p.label : undefined;
  if (hasWs) {
    const sourceId = p.workspace_id as string;
    cwd = await resolveCwd(deps, session, sourceId);
    label ??= deps.index.get(session, sourceId)?.label;
  } else {
    cwd = p.cwd as string;
    if (!isAbsolute(cwd)) throw new BrokerError("bad_request", "'cwd' must be an absolute path");
    let stat;
    try {
      stat = statSync(cwd);
    } catch {
      throw new BrokerError("bad_request", `'cwd' does not exist: ${cwd}`);
    }
    if (!stat.isDirectory()) throw new BrokerError("bad_request", `'cwd' is not a directory: ${cwd}`);
  }

  const created = (await deps.local.request(session, "workspace.create", { cwd, ...(label ? { label } : {}) }, 15_000)) as {
    root_pane?: { pane_id?: unknown };
  };
  const paneId = typeof created?.root_pane?.pane_id === "string" ? created.root_pane.pane_id : undefined;
  if (!paneId || !paneId.includes(":")) {
    throw new BrokerError("upstream_error", "workspace.create returned no root pane");
  }
  const workspaceId = paneId.split(":")[0];
  deps.index.set(session, workspaceId, { cwd, ...(label ? { label } : {}) });

  const name = typeof p.name === "string" ? p.name : kind;
  const timeoutMs = typeof p.timeout_ms === "number" ? p.timeout_ms : undefined;
  try {
    await deps.local.request(
      session,
      "agent.start",
      { name, kind, pane_id: paneId, ...(args ? { args } : {}), ...(timeoutMs ? { timeout_ms: timeoutMs } : {}) },
      (timeoutMs ?? 30_000) + 5000,
    );
  } catch (e) {
    // The workspace exists — hand its id back so the client can retry into
    // it with mode B instead of leaking it (spec §2.1).
    const err = e instanceof BrokerError ? e : new BrokerError("upstream_error", String(e));
    throw new BrokerError(err.code, err.message, { ...err.details, workspace_id: workspaceId, pane_id: paneId });
  }

  const raw = (await deps.local.request(session, "agent.list", {}, 5000).catch(() => ({}))) as {
    agents?: Array<Record<string, unknown>>;
  };
  const entry = raw.agents?.find((a) => a.pane_id === paneId);
  return { workspace_id: workspaceId, pane_id: paneId, agent: name, status: foldStatus(entry?.agent_status) };
}

async function ask(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  throw new BrokerError("bad_request", "broker.agent.ask not implemented yet (plan Task 9)");
}
