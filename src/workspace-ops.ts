import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import {
  activeContextPreamble,
  deleteContext,
  getContext,
  listContext,
  putContext,
  updateContext,
} from "./context-store.js";
import type { EnvRegistry } from "./env-registry.js";
import type { BrokerEvents } from "./broker-events.js";
import { BrokerError } from "./errors.js";
import { awaitShellReady } from "./spawn-readiness.js";
import type { ModelRegistry } from "./model-registry.js";
import {
  DIFF_CAP_BYTES,
  discoverRepos,
  repoCheckout,
  repoCommit,
  repoDiscard,
  repoDiff,
  repoLog,
  repoPull,
  repoPush,
  repoStash,
  repoStashList,
  repoStashPop,
  repoTree,
  resolveRepo,
} from "./git-exec.js";
import type { LocalHerdr } from "./local-attach.js";
import type { Registry } from "./registry.js";
import type { AgentIndex, WorkspaceIndex } from "./state.js";
import type { CliProfiles } from "./cli-profiles.js";
import { prepareWorkspace } from "./prepare-workspace.js";
import { holdsReady } from "./readiness.js";
import { classifySession } from "./reconcile.js";
import { decideTurn, readTurnState } from "./transcript.js";

export interface OpsDeps {
  local: LocalHerdr;
  registry: Registry;
  index: WorkspaceIndex;
  env: EnvRegistry;
  models: ModelRegistry;
  agents: AgentIndex;
  profiles: CliProfiles;
  /** broker's own state dir — prepareWorkspace materializes broker-owned
   * CLI config dirs (e.g. trust-dialog pre-acceptance) under here */
  stateDir: string;
  /** test overrides for broker.agent.ask pacing */
  askPollMs?: number;
  askGraceMs?: number;
  /** how long ask() waits for the agent to start working before failing fast */
  askStartGraceMs?: number;
  /** how long spawn waits for the readiness sentinel before falling through
   * to the agent_pane_busy retry; 0 disables it (spec 2026-08-28). Replaces
   * the old envSettleMs sleep, which approximated this by guessing. */
  readinessTimeoutMs?: number;
  /** cold-pane agent.start retry pacing (agent_pane_busy) */
  paneBusyRetries?: number;
  paneBusyDelayMs?: number;
  /** test override for spec-bundle long-poll pacing */
  filePollMs?: number;
  /** in-flight ask locks, keyed `${session}:${pane}` — lazily initialized */
  askLocks?: Set<string>;
  /** test override for pane-screen long-poll pacing */
  screenPollMs?: number;
  /** test override for the readiness settle window */
  settleMsOverride?: number;
  /** broker.* event bus; absent when no modules are configured, so every
   * emit site is `deps.events?.emit(...)` and costs nothing when unused */
  events?: BrokerEvents;
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
  // Env registry ops are instance-global (env spec §3) — the session only
  // carried the transport, so they dispatch before the session check.
  const p0 = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "broker.env.set": {
      const scope = {
        kind: typeof p0.kind === "string" ? p0.kind : undefined,
        session: typeof p0.session === "string" ? p0.session : undefined,
      };
      return { status: "stored", ...deps.env.set(str(p0.name, "name"), str(p0.value, "value"), scope) };
    }
    case "broker.env.list":
      return { vars: deps.env.list() };
    case "broker.env.delete": {
      deps.env.delete(str(p0.name, "name"), {
        kind: typeof p0.kind === "string" ? p0.kind : undefined,
        session: typeof p0.session === "string" ? p0.session : undefined,
      });
      return { status: "deleted" };
    }
    case "broker.models.list":
      return { models: deps.models.list(typeof p0.kind === "string" ? p0.kind : undefined) };
  }
  if (!deps.local.sessions().includes(session)) {
    throw new BrokerError("unknown_session", `no local session '${session}'`);
  }
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case "broker.workspace.close": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      // Wire-verified herdr surface (schema probe 2026-08-21): closes the
      // workspace and every pane in it — the mode-B leak's cleanup path.
      await deps.local.request(session, "workspace.close", { workspace_id: workspaceId }, 15_000);
      deps.index.remove(session, workspaceId);
      // Every agent row for this workspace dies with it — a pane id herdr
      // later reuses must not inherit a stale kind/sessionId pointing a
      // transcript read at a previous agent that no longer exists.
      deps.agents.removeWorkspace(session, workspaceId);
      return { workspace_id: workspaceId, closed: true };
    }
    case "broker.workspace.list":
      return listWorkspaces(deps, session);
    // Report-never-reap surface (see classifySession): live workspaces the
    // broker has no index row for. Kills nothing — pure inspection.
    case "broker.session.orphans": {
      const live = [...(await herdrWorkspaces(deps, session)).keys()];
      return { session, ...classifySession(deps.index.all(session), live) };
    }
    case "broker.worktree.list": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      const cwd = await resolveCwd(deps, session, workspaceId);
      const r = (await deps.local.request(session, "worktree.list", { cwd }, 15_000)) as {
        source?: unknown;
        worktrees?: unknown[];
      };
      return { workspace_id: workspaceId, source: r?.source ?? null, worktrees: r?.worktrees ?? [] };
    }
    case "broker.worktree.remove": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      // Unlike workspace.close, this DELETES the checkout directory too;
      // the BRANCH survives (wire-verified) — the work stays mergeable.
      const r = (await deps.local.request(
        session,
        "worktree.remove",
        { workspace_id: workspaceId, ...(p.force === true ? { force: true } : {}) },
        15_000,
      )) as { path?: unknown };
      deps.index.remove(session, workspaceId);
      deps.agents.removeWorkspace(session, workspaceId);
      return { workspace_id: workspaceId, removed: true, path: typeof r?.path === "string" ? r.path : null };
    }
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
    case "broker.repo.file":
      return repoFile(deps, session, p);
    case "broker.repo.commit": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      const repo = str(p.repo, "repo");
      const cwd = await resolveCwd(deps, session, workspaceId);
      const author =
        p.author && typeof p.author === "object"
          ? { name: str((p.author as Record<string, unknown>).name, "author.name"), email: str((p.author as Record<string, unknown>).email, "author.email") }
          : undefined;
      const result = await repoCommit(resolveRepo(cwd, repo), {
        message: str(p.message, "message"),
        addAll: p.add_all === false ? false : true,
        ...(author ? { author } : {}),
      });
      deps.events?.emit("broker.repo.pushed", { workspace_id: workspaceId, repo });
      return { workspace_id: workspaceId, repo, ...result };
    }
    case "broker.repo.log": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      const repo = str(p.repo, "repo");
      const cwd = await resolveCwd(deps, session, workspaceId);
      const limit = typeof p.limit === "number" ? p.limit : 20;
      return { workspace_id: workspaceId, repo, commits: await repoLog(resolveRepo(cwd, repo), limit) };
    }
    case "broker.repo.push": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      const repo = str(p.repo, "repo");
      const cwd = await resolveCwd(deps, session, workspaceId);
      const result = await repoPush(resolveRepo(cwd, repo), {
        ...(typeof p.remote === "string" ? { remote: p.remote } : {}),
        ...(typeof p.branch === "string" ? { branch: p.branch } : {}),
      });
      return { workspace_id: workspaceId, repo, ...result };
    }
    // Workspace context attachments — binary rides base64 so the same
    // methods work through the parent↔child tunnel unchanged.
    case "broker.context.put": {
      const cwd = await resolveCwd(deps, session, str(p.workspace_id, "workspace_id"));
      const content = Buffer.from(str(p.content_b64, "content_b64"), "base64");
      return putContext(cwd, str(p.name, "name"), content, {
        ...(typeof p.content_type === "string" ? { contentType: p.content_type } : {}),
        ...(p.active === false ? { active: false } : {}),
        ...(p.inline === true ? { inline: true } : {}),
      });
    }
    case "broker.context.list": {
      const cwd = await resolveCwd(deps, session, str(p.workspace_id, "workspace_id"));
      return { workspace_id: p.workspace_id, attachments: listContext(cwd) };
    }
    case "broker.context.get": {
      const cwd = await resolveCwd(deps, session, str(p.workspace_id, "workspace_id"));
      const { content, meta } = getContext(cwd, str(p.name, "name"));
      return { ...meta, content_b64: content.toString("base64") };
    }
    case "broker.context.set": {
      const cwd = await resolveCwd(deps, session, str(p.workspace_id, "workspace_id"));
      const patch: { active?: boolean; inline?: boolean } = {};
      if (typeof p.active === "boolean") patch.active = p.active;
      if (typeof p.inline === "boolean") patch.inline = p.inline;
      if (Object.keys(patch).length === 0) {
        throw new BrokerError("bad_request", "pass 'active' and/or 'inline' as booleans");
      }
      return updateContext(cwd, str(p.name, "name"), patch);
    }
    case "broker.context.delete": {
      const cwd = await resolveCwd(deps, session, str(p.workspace_id, "workspace_id"));
      deleteContext(cwd, str(p.name, "name"));
      return { status: "deleted" };
    }
    case "broker.repo.pull": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      const repo = str(p.repo, "repo");
      const cwd = await resolveCwd(deps, session, workspaceId);
      const result = await repoPull(resolveRepo(cwd, repo), {
        ...(typeof p.remote === "string" ? { remote: p.remote } : {}),
        ...(typeof p.branch === "string" ? { branch: p.branch } : {}),
        ...(p.rebase === true ? { rebase: true } : {}),
      });
      return { workspace_id: workspaceId, repo, ...result };
    }
    case "broker.repo.discard": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      const repo = str(p.repo, "repo");
      const cwd = await resolveCwd(deps, session, workspaceId);
      const result = await repoDiscard(resolveRepo(cwd, repo), {
        ...(Array.isArray(p.paths) ? { paths: p.paths.map(String) } : {}),
        ...(p.all === true ? { all: true } : {}),
        ...(p.untracked === true ? { untracked: true } : {}),
        ...(typeof p.confirm === "string" ? { confirm: p.confirm } : {}),
      });
      return { workspace_id: workspaceId, repo, ...result };
    }
    case "broker.repo.stash": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      const repo = str(p.repo, "repo");
      const cwd = await resolveCwd(deps, session, workspaceId);
      const result = await repoStash(resolveRepo(cwd, repo), {
        ...(typeof p.message === "string" ? { message: p.message } : {}),
        ...(p.untracked === true ? { untracked: true } : {}),
      });
      return { workspace_id: workspaceId, repo, ...result };
    }
    case "broker.repo.stash_list": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      const repo = str(p.repo, "repo");
      const cwd = await resolveCwd(deps, session, workspaceId);
      return { workspace_id: workspaceId, repo, stashes: await repoStashList(resolveRepo(cwd, repo)) };
    }
    case "broker.repo.stash_pop": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      const repo = str(p.repo, "repo");
      const cwd = await resolveCwd(deps, session, workspaceId);
      const result = await repoStashPop(resolveRepo(cwd, repo));
      return { workspace_id: workspaceId, repo, ...result };
    }
    case "broker.repo.checkout": {
      const workspaceId = str(p.workspace_id, "workspace_id");
      const repo = str(p.repo, "repo");
      const cwd = await resolveCwd(deps, session, workspaceId);
      const result = await repoCheckout(resolveRepo(cwd, repo), {
        ref: str(p.ref, "ref"),
        ...(p.create === true ? { create: true } : {}),
      });
      return { workspace_id: workspaceId, repo, ...result };
    }
    case "broker.agent.spawn":
      return spawn(deps, session, p);
    case "broker.pane.screen":
      return screen(deps, session, p);
    case "broker.pane.exec":
      return execCommand(deps, session, p);
    case "broker.agent.stop":
      return stopAgent(deps, session, p);
    case "broker.agent.wait":
      return waitAgent(deps, session, p);
    case "broker.agent.explain": {
      const pane = str(p.pane_id, "pane_id");
      const { kind, entry } = await agentInPane(deps, session, pane);
      const target = typeof entry.name === "string" && entry.name ? entry.name : String(entry.agent ?? kind);
      const r = (await deps.local.request(session, "agent.explain", { target }, 15_000)) as { explain?: unknown };
      return { pane_id: pane, agent: target, kind, explain: r?.explain ?? null };
    }
    case "broker.agent.ask":
      return ask(deps, session, p);
    case "broker.agent.model":
      return switchModel(deps, session, p);
    case "broker.agent.slash":
      return slash(deps, session, p);
    case "broker.agent.prompt":
      return steer(deps, session, p);
    case "broker.spec.drive":
      return specDrive(deps, session, p);
    case "broker.spec.plan":
      return specPlan(deps, session, p);
    case "broker.spec.get":
      return specGet(deps, session, p);
    case "broker.spec.list":
      return specList(deps, session, p);
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

/** The ONE cwd lookup, shared by every caller: herdr's own view first, the
 * broker's index as fallback.
 *
 * Non-throwing on purpose (roadmap 25(b)). `wait` and `ask` used to resolve
 * differently — ask through resolveCwd, wait by reading the index directly —
 * so on a mode-C worktree spawn, where the index deliberately holds the
 * CHECKOUT path while herdr reports its own, the two produced different
 * `cwdSlug`s and therefore two different transcript paths for ONE pane. It
 * degraded safely (wrong slug -> no file -> status tier), which is exactly
 * why it went unnoticed.
 *
 * `wait` could not simply adopt resolveCwd, because throwing
 * `unknown_workspace` would turn a currently-succeeding wait into an error.
 * So the shared part returns undefined and each caller keeps its own failure
 * mode: resolveCwd throws, wait treats it as "no transcript tier". */
async function lookupCwd(deps: OpsDeps, session: string, workspaceId: string): Promise<string | undefined> {
  return (await herdrWorkspaces(deps, session)).get(workspaceId)?.cwd ?? deps.index.get(session, workspaceId)?.cwd;
}

async function resolveCwd(deps: OpsDeps, session: string, workspaceId: string): Promise<string> {
  const cwd = await lookupCwd(deps, session, workspaceId);
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
  // Mode C — worktree spawns: branch off the repo at `cwd` into an
  // isolated checkout (herdr worktree.create, wire-verified) and run the
  // agent there. Requires mode A's cwd; the branch is the whole point.
  let worktreeReq: { branch: string; base?: string } | undefined;
  if (p.worktree !== undefined) {
    if (hasWs) throw new BrokerError("bad_request", "'worktree' spawns need 'cwd' (the repo root), not 'workspace_id'");
    const wt = p.worktree as Record<string, unknown> | null;
    const branch = wt?.branch;
    if (typeof branch !== "string" || !branch || branch.length > 200 || /[\p{Cc}\s]/u.test(branch)) {
      throw new BrokerError("bad_request", "'worktree.branch' is required (a git branch name, no spaces)");
    }
    worktreeReq = { branch, ...(typeof wt?.base === "string" && wt.base ? { base: wt.base } : {}) };
  }

  let cwd: string;
  const label = typeof p.label === "string" ? p.label : undefined;
  if (!hasWs) {
    cwd = p.cwd as string;
    if (!isAbsolute(cwd)) throw new BrokerError("bad_request", "'cwd' must be an absolute path");
    let stat;
    try {
      stat = statSync(cwd);
    } catch {
      throw new BrokerError("bad_request", `'cwd' does not exist: ${cwd}`);
    }
    if (!stat.isDirectory()) throw new BrokerError("bad_request", `'cwd' is not a directory: ${cwd}`);
  } else {
    cwd = await resolveCwd(deps, session, p.workspace_id as string);
  }

  // Env spec §5: resolve first — a failing hook must not leave an orphan
  // workspace or pane behind. prepareWorkspace's vars ride the same
  // injection path, so a trust dialog is answered before the CLI starts
  // rather than screen-scraped after it appears.
  //
  // prepareWorkspace does local disk I/O (mkdir/chmod/write) that can
  // throw for reasons entirely outside this spawn's control — a read-only
  // stateDir, a pre-existing cli-config/<kind> the broker doesn't own
  // giving EPERM on chmod. A trust-dialog convenience must never fail a
  // spawn that would otherwise have succeeded: degrade to {} and let the
  // CLI's own first-run dialog reappear, exactly as before this existed.
  let prepared: Record<string, string>;
  try {
    prepared = prepareWorkspace(deps.profiles.get(kind) ?? { kind, source: "builtin" }, deps.stateDir);
  } catch {
    prepared = {};
  }
  const injected = { ...prepared, ...(await deps.env.resolveForSpawn(session, kind)) };

  let paneId: string;
  let workspaceId: string;
  let worktreeMade: { branch: string; path: string } | undefined;
  if (hasWs) {
    // Mode B — join the EXISTING workspace via pane.split (wire-verified,
    // schema probe 2026-08-21). herdr injects the env map natively into
    // the new pane's shell, so no drop file is needed on this path.
    workspaceId = p.workspace_id as string;
    const split = (await deps.local.request(
      session,
      "pane.split",
      {
        workspace_id: workspaceId,
        direction: "right",
        cwd,
        ...(Object.keys(injected).length > 0 ? { env: injected } : {}),
      },
      15_000,
    )) as { pane?: { pane_id?: unknown } };
    const splitPane = typeof split?.pane?.pane_id === "string" ? split.pane.pane_id : undefined;
    if (!splitPane || !splitPane.includes(":")) {
      throw new BrokerError("upstream_error", "pane.split returned no pane");
    }
    paneId = splitPane;
  } else if (worktreeReq) {
    const made = (await deps.local.request(
      session,
      "worktree.create",
      { cwd, branch: worktreeReq.branch, ...(worktreeReq.base ? { base: worktreeReq.base } : {}) },
      30_000,
    )) as { root_pane?: { pane_id?: unknown }; worktree?: { path?: unknown } };
    const wtPane = typeof made?.root_pane?.pane_id === "string" ? made.root_pane.pane_id : undefined;
    if (!wtPane || !wtPane.includes(":")) {
      throw new BrokerError("upstream_error", "worktree.create returned no root pane");
    }
    paneId = wtPane;
    workspaceId = paneId.split(":")[0];
    const checkout = typeof made?.worktree?.path === "string" ? made.worktree.path : cwd;
    // the CHECKOUT is this workspace's cwd — repo/git/context endpoints
    // operate inside the worktree
    deps.index.set(session, workspaceId, { cwd: checkout, ...(label ? { label } : {}) });
    worktreeMade = { branch: worktreeReq.branch, path: checkout };
  } else {
    const created = (await deps.local.request(
      session,
      "workspace.create",
      { cwd, ...(label ? { label } : {}) },
      15_000,
    )) as { root_pane?: { pane_id?: unknown } };
    const rootPane = typeof created?.root_pane?.pane_id === "string" ? created.root_pane.pane_id : undefined;
    if (!rootPane || !rootPane.includes(":")) {
      throw new BrokerError("upstream_error", "workspace.create returned no root pane");
    }
    paneId = rootPane;
    workspaceId = paneId.split(":")[0];
    deps.index.set(session, workspaceId, { cwd, ...(label ? { label } : {}) });
  }

  // Spawn readiness (spec 2026-08-28-spawn-readiness-design.md). Every path
  // above hands back a pane whose login shell may not have reached its prompt
  // — workspace.create, pane.split and worktree.create alike — and until now
  // only mode A WITH env injection settled at all, by sleeping 300ms. Prove
  // it instead: push a sentinel and wait for the echo.
  //
  // The env drop file composes into the SAME send, so sourcing the env and
  // proving readiness are one round trip. Order matters and the shell
  // guarantees it: the sentinel cannot echo before the source completes.
  const envDrop = !hasWs && Object.keys(injected).length > 0 ? deps.env.writeDropFile(injected) : undefined;
  try {
    await awaitShellReady(deps, session, paneId, {
      // Env injection failing is a real error for the caller; the sentinel
      // failing is not — it falls through to the agent_pane_busy retry.
      ...(envDrop !== undefined
        ? { prefix: ` . ${envDrop}; rm -f ${envDrop}`, throwOnSendFailure: true }
        : {}),
    });
  } catch (e) {
    // Only reachable with throwOnSendFailure, i.e. only when a drop file was
    // written — the readiness half never throws.
    rmSync(envDrop as string, { force: true });
    const err = e instanceof BrokerError ? e : new BrokerError("upstream_error", String(e));
    throw new BrokerError(err.code, `env injection failed: ${err.message}`, {
      ...err.details,
      workspace_id: workspaceId,
      pane_id: paneId,
    });
  }

  const explicitName = typeof p.name === "string";
  let name = explicitName ? (p.name as string) : kind;
  const timeoutMs = typeof p.timeout_ms === "number" ? p.timeout_ms : undefined;
  // agent_pane_busy on a fresh pane means the shell hasn't reached its
  // prompt yet (slow login zsh) — herdr's refusal is the only verified
  // readiness signal, so retry the SAME pane instead of failing out to a
  // client whose mode-B retry would leak a new workspace per attempt.
  const busyRetries = deps.paneBusyRetries ?? 4;
  const busyDelayMs = deps.paneBusyDelayMs ?? 1000;
  // Session-id pinning: when the CLI can be told its own session id, the
  // transcript path is known in advance instead of discovered by scanning
  // and guessing which file belongs to which pane. Two of five CLIs have
  // such a flag; the rest are discovered by cwd map + startedAt bound.
  const profile = deps.profiles.get(kind);
  let pinnedId: string | undefined;
  if (profile?.pin) {
    pinnedId = randomUUID();
    args = [...(args ?? []), profile.pin.flag, pinnedId];
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await deps.local.request(
        session,
        "agent.start",
        { name, kind, pane_id: paneId, ...(args ? { args } : {}), ...(timeoutMs ? { timeout_ms: timeoutMs } : {}) },
        (timeoutMs ?? 30_000) + 5000,
      );
      break;
    } catch (e) {
      const err = e instanceof BrokerError ? e : new BrokerError("upstream_error", String(e));
      if (err.code === "agent_pane_busy" && attempt < busyRetries) {
        await new Promise((r) => setTimeout(r, busyDelayMs));
        continue;
      }
      // Agent names are session-unique (wire truth, live 0.8.x). A collision
      // on the DEFAULT name (= kind) retries once with a pane-unique one; an
      // explicit name is the caller's choice, so their collision fails through.
      if (err.code === "agent_name_taken" && !explicitName && name === kind) {
        name = `${kind}-${paneId.split(":").join("")}`;
        continue;
      }
      // The workspace exists — hand its id back so the client can retry into
      // it with mode B instead of leaking it (spec §2.1).
      deps.events?.emit("broker.agent.spawn_failed", { kind, code: err.code, message: err.message });
      throw new BrokerError(err.code, err.message, { ...err.details, workspace_id: workspaceId, pane_id: paneId });
    }
  }

  // Readiness settle: sample interactive_ready repeatedly across the
  // profile's window. The LEVEL property — "stayed ready", not just "was
  // ready once" — comes from this repeated sampling, not from holdsReady
  // itself; holdsReady only asks whether any sample ever proved the pane
  // had stopped. A pane that renders and then dies fails here instead of
  // being handed back as a live pane id. Only an explicit false fails the
  // spawn — a herdr that never reports the field yields undefined samples,
  // and spawn proceeds as it does today; this must not break instances
  // whose herdr omits interactive_ready.
  const settleMs = deps.settleMsOverride ?? deps.profiles.get(kind)?.settleMs ?? 2500;
  if (settleMs > 0) {
    const gap = Math.max(250, Math.floor(settleMs / 3));
    const samples: Array<boolean | undefined> = [];
    for (let i = 0; i * gap < settleMs; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, gap));
      const list = (await deps.local.request(session, "agent.list", {}, 5000).catch(() => ({}))) as {
        agents?: Array<Record<string, unknown>>;
      };
      const e = list.agents?.find((a) => a.pane_id === paneId);
      samples.push(typeof e?.interactive_ready === "boolean" ? e.interactive_ready : undefined);
    }
    if (!holdsReady(samples)) {
      throw new BrokerError(
        "upstream_error",
        `agent in pane '${paneId}' became ready then stopped being ready within ${settleMs}ms — it likely crashed on startup`,
        { workspace_id: workspaceId, pane_id: paneId },
      );
    }
  }

  // Recorded only once the pane is confirmed to have survived its settle
  // window — a settle failure above must not leave a permanent orphan row
  // (nothing later removes it) for a pane that never became a live agent.
  deps.agents.set(session, paneId, { ...(pinnedId ? { sessionId: pinnedId } : {}), kind, startedAt: Date.now() });

  const raw = (await deps.local.request(session, "agent.list", {}, 5000).catch(() => ({}))) as {
    agents?: Array<Record<string, unknown>>;
  };
  const entry = raw.agents?.find((a) => a.pane_id === paneId);
  deps.events?.emit("broker.agent.spawned", { pane_id: paneId, workspace_id: workspaceId, kind });
  return {
    workspace_id: workspaceId,
    pane_id: paneId,
    agent: name,
    status: foldStatus(entry?.agent_status),
    ...(worktreeMade ? { worktree: worktreeMade } : {}),
  };
}

/** Resolves the agent occupying a pane (or throws) — shared by the
 * pane-targeted TUI drivers below. A just-launched agent can be listed
 * WITHOUT its `agent` (kind) field for a moment (observed on real herdr
 * 0.8.0 right after agent.start), so a listed-but-kindless entry is
 * re-polled briefly before falling back to the agent's name. */
async function agentInPane(
  deps: OpsDeps,
  session: string,
  pane: string,
): Promise<{ kind: string; entry: Record<string, unknown> }> {
  let entry: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, deps.paneBusyDelayMs ?? 300));
    const raw = (await deps.local.request(session, "agent.list", {}, 10_000)) as {
      agents?: Array<Record<string, unknown>>;
    };
    entry = raw.agents?.find((a) => a.pane_id === pane);
    if (!entry) throw new BrokerError("bad_request", `no agent in pane '${pane}'`);
    if (typeof entry.agent === "string" && entry.agent) return { kind: entry.agent, entry };
  }
  const nameAsKind = typeof entry!.name === "string" && entry!.name ? entry!.name : undefined;
  if (!nameAsKind) throw new BrokerError("upstream_error", `agent in pane '${pane}' reports no kind`);
  return { kind: nameAsKind, entry: entry! };
}

/** Active context attachments ride every prompt — resolved best-effort so a
 * workspace the index doesn't know about still steers, just without them. */
async function contextPreambleFor(deps: OpsDeps, session: string, pane: string): Promise<string | undefined> {
  try {
    const cwd = await resolveCwd(deps, session, pane.split(":")[0]);
    return activeContextPreamble(cwd);
  } catch {
    return undefined;
  }
}

const AGENT_STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);

/** Consumer wait: block until the agent transitions into a target status
 * (herdr agent.wait — a current state that already matches returns
 * immediately) or until the pane's output matches (pane.wait_for_output).
 * herdr's timeout becomes a branchable 200-shape, mirroring the screen
 * endpoint's `unchanged` — pipelines fork on it without try/catch. */
async function waitAgent(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const pane = str(p.pane_id, "pane_id");
  const timeoutMs = Math.min(Math.max(typeof p.timeout_ms === "number" ? p.timeout_ms : 30_000, 1_000), 600_000);
  const hasMatch = typeof p.match === "string" && p.match.length > 0;
  if (hasMatch && p.until !== undefined) {
    throw new BrokerError("bad_request", "pass either 'until' (status wait) or 'match' (output wait), not both");
  }
  const { entry } = await agentInPane(deps, session, pane);
  const target = typeof entry.name === "string" && entry.name ? entry.name : String(entry.agent ?? "");

  try {
    if (hasMatch) {
      const matchType = p.match_type === "regex" ? "regex" : "substring";
      const source = p.source === "recent" ? "recent" : "visible";
      const r = (await deps.local.request(
        session,
        "pane.wait_for_output",
        { pane_id: pane, source, match: { type: matchType, value: p.match }, timeout_ms: timeoutMs },
        timeoutMs + 10_000,
      )) as { matched_line?: unknown };
      return { waited: true, matched_line: typeof r?.matched_line === "string" ? r.matched_line : "", pane_id: pane };
    }
    let until = ["idle", "blocked", "done"];
    if (p.until !== undefined) {
      if (!Array.isArray(p.until) || p.until.length === 0 || !p.until.every((u) => AGENT_STATUSES.has(String(u)))) {
        throw new BrokerError("bad_request", "'until' must be a non-empty array of idle|working|blocked|done|unknown");
      }
      until = p.until.map(String);
    }
    // Freshness is bound to THIS wait's own start, not the agent's spawn
    // time: herdr resolves agent.wait first and we read the transcript
    // after, so binding to spawn would let ANY record written since launch
    // (even a stale one, predating this call) count as evidence about a
    // status herdr already correctly resolved — silently overwriting a
    // status that satisfied `until` with one that doesn't.
    const requestedAt = Date.now();
    const r = (await deps.local.request(
      session,
      "agent.wait",
      { target, until, timeout_ms: timeoutMs },
      timeoutMs + 10_000,
    )) as { agent?: { agent_status?: unknown } };
    const raw = String(r?.agent?.agent_status ?? "unknown");
    const meta = deps.agents.get(session, pane);
    const profile = meta ? deps.profiles.get(meta.kind) : undefined;
    // The same lookup ask uses — herdr's view first, index as fallback — so
    // one pane cannot yield two transcript paths. Non-throwing: an
    // unresolvable cwd just means no transcript tier for this wait.
    const cwd = await lookupCwd(deps, session, pane.split(":")[0]);
    const t = meta && profile && cwd ? readTurnState(profile, meta, cwd, undefined, deps.stateDir) : null;
    const d = decideTurn(t, { status: foldStatus(raw), raw_status: raw }, requestedAt);
    return { waited: true, status: d.status, raw_status: d.raw_status, evidence: d.evidence, pane_id: pane };
  } catch (e) {
    const err = e instanceof BrokerError ? e : new BrokerError("upstream_error", String(e));
    if (err.code === "timeout") return { waited: false, timed_out: true, pane_id: pane };
    throw err;
  }
}

/** Agent stop: closes the pane the agent lives in (herdr pane.close,
 * wire-verified) — the agent process dies with its PTY; the workspace and
 * the rest of the team survive. Requires an agent in the pane so a typo'd
 * pane id cannot silently close someone's plain shell. */
async function stopAgent(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const pane = str(p.pane_id, "pane_id");
  const { kind, entry } = await agentInPane(deps, session, pane);
  const agent = typeof entry.name === "string" && entry.name ? entry.name : String(entry.agent ?? kind);
  await deps.local.request(session, "pane.close", { pane_id: pane }, 15_000);
  // The agent's life ends with its pane — a reused pane id must not
  // inherit this agent's stale kind/sessionId for a future transcript read.
  deps.agents.remove(session, pane);
  return { stopped: true, pane_id: pane, agent, kind };
}

/** Fire-and-forget steering: a free-form prompt to the pane's agent with no
 * reply contract — the pure "keep directing the same agent" channel. Use
 * ask for a structured answer; watch progress via WS status events or
 * pane.read. */
async function steer(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const pane = str(p.pane_id, "pane_id");
  const text = str(p.text, "text");
  if (text.length > 32_000) throw new BrokerError("bad_request", "'text' must be at most 32000 chars");
  const { kind, entry } = await agentInPane(deps, session, pane);
  const target = typeof entry.name === "string" && entry.name ? entry.name : String(entry.agent ?? "");
  if (!target) throw new BrokerError("upstream_error", `agent in pane '${pane}' has no addressable name`);
  const preamble = await contextPreambleFor(deps, session, pane);
  const full = preamble ? `${preamble}\n\n${text}` : text;
  await deps.local.request(session, "agent.prompt", { target, text: full }, 30_000);
  return { status: "prompted", pane_id: pane, kind, agent: target };
}

/** Live pane viewer: the terminal screen as data, long-polled by content
 * version exactly like spec-bundle GET. Rides the verified pane.read — no
 * new herdr surface. `visible` is the live screen; `recent` is scrollback,
 * tail-truncated because the recent end is the part a viewer needs. */
const SCREEN_CAP_CHARS = 262_144;

async function screen(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const pane = str(p.pane_id, "pane_id");
  const source = p.source ?? "visible";
  if (source !== "visible" && source !== "recent") {
    throw new BrokerError("bad_request", "'source' must be 'visible' or 'recent'");
  }
  const known = typeof p.version === "string" ? p.version : undefined;
  const waitMs = Math.min(Math.max(typeof p.wait_ms === "number" ? p.wait_ms : 0, 0), 30_000);
  const pollMs = deps.screenPollMs ?? 500;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = (await deps.local.request(session, "pane.read", { pane_id: pane, source }, 10_000)) as {
      read?: { text?: string };
    };
    let text = r?.read?.text ?? "";
    const truncated = text.length > SCREEN_CAP_CHARS;
    if (truncated) text = text.slice(-SCREEN_CAP_CHARS);
    const version = createHash("sha256").update(text).digest("hex").slice(0, 16);
    if (!known || version !== known) {
      return {
        pane_id: pane,
        source,
        text,
        version,
        as_of: new Date().toISOString(),
        ...(truncated ? { truncated: true } : {}),
      };
    }
    if (Date.now() >= deadline) return { pane_id: pane, source, version, unchanged: true };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Generic slash driver: types the CLI's own /command into the pane. The
 * single-line args rule is load-bearing — an embedded newline would smuggle
 * a second Enter-terminated command or a whole prompt through what claims
 * to be one slash command. Freeform by design (the TUI is the validator);
 * broker.agent.model is the curated, catalog-checked special case. */
async function slash(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const pane = str(p.pane_id, "pane_id");
  const command = str(p.command, "command");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(command) || command.length > 32) {
    throw new BrokerError("bad_request", `'command' must be a slash command name ([a-zA-Z0-9_-], max 32 chars)`);
  }
  let args: string | undefined;
  if (p.args !== undefined) {
    if (typeof p.args !== "string" || p.args.length > 512 || /[\p{Cc}]/u.test(p.args)) {
      throw new BrokerError("bad_request", "'args' must be a single line of at most 512 chars (no control characters)");
    }
    args = p.args.trim() || undefined;
  }
  const { kind } = await agentInPane(deps, session, pane);
  const text = `/${command}${args ? ` ${args}` : ""}`;
  await deps.local.request(session, "pane.send_input", { pane_id: pane, text, keys: ["Enter"] }, 10_000);
  return { status: "sent", pane_id: pane, kind, command: text };
}

/** Model switching rides the pane: no herdr method nor CLI API exists, so
 * the registry renders the agent CLI's own model command (e.g. "/model
 * gpt-5") and it is typed into the TUI. "sent" semantics — a TUI gives no
 * machine ack, so callers wanting confirmation pane.read afterwards. */
async function switchModel(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const pane = str(p.pane_id, "pane_id");
  const model = str(p.model, "model");
  const { kind } = await agentInPane(deps, session, pane);
  if (!deps.models.find(kind, model)) {
    throw new BrokerError(
      "unknown_model",
      `no model '${model}' for kind '${kind}' — extend [[models.catalog]] in config.toml`,
      { kind, known: deps.models.list(kind).map((m) => m.id) },
    );
  }
  const command = deps.models.switchCommand(kind, model);
  if (!command) {
    throw new BrokerError(
      "model_switch_unsupported",
      `kind '${kind}' has no switch command — add a [[models.switch]] template in config.toml`,
      { kind },
    );
  }
  await deps.local.request(session, "pane.send_input", { pane_id: pane, text: command, keys: ["Enter"] }, 10_000);
  return { status: "sent", pane_id: pane, kind, model, command };
}

/** Capped, binary-aware text read shared by the file endpoint and spec
 * bundles. */
function capText(buf: Buffer): { size: number; content: string; truncated?: boolean; binary?: boolean } {
  if (buf.subarray(0, 8192).includes(0)) return { size: buf.length, content: "", binary: true };
  if (buf.length > DIFF_CAP_BYTES) {
    return { size: buf.length, content: buf.subarray(0, DIFF_CAP_BYTES).toString("utf8"), truncated: true };
  }
  return { size: buf.length, content: buf.toString("utf8") };
}

/** Raw file contents from a workspace repo — the piece tree/diff can't
 * serve (an IDE-like UI can show changed files but couldn't open an
 * unchanged one). Same trust model as the rest of the bearer surface: rpc
 * passthrough could already read any file via the pane, so this adds
 * convenience, not privilege — but containment is still enforced. */
async function repoFile(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const workspaceId = str(p.workspace_id, "workspace_id");
  const repo = str(p.repo, "repo");
  const rel = str(p.path, "path");
  if (isAbsolute(rel) || rel.split("/").some((s) => s === "" || s === "." || s === ".." || s === ".git")) {
    throw new BrokerError("bad_request", "'path' must be relative, inside the repo, and outside .git");
  }
  const cwd = await resolveCwd(deps, session, workspaceId);
  const repoDir = resolveRepo(cwd, repo);
  const abs = join(repoDir, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new BrokerError("unknown_file", `no file '${rel}' in repo '${repo}'`);
  }
  const real = realpathSync(abs);
  if (real !== abs && !real.startsWith(repoDir + sep)) {
    throw new BrokerError("bad_request", "'path' escapes the repo through a symlink");
  }
  return { workspace_id: workspaceId, repo, path: rel, ...capText(readFileSync(abs)) };
}

/* ── spec bundles ─────────────────────────────────────────────────────────
 * A bundle is a directory of design files the agent maintains —
 * docs/superpowers/specs/<YYYY-MM-DD-name>/ with overview.md as the entry
 * point plus whatever the design needs (api.md, data-model.md, plan.md…).
 * drive/plan prompt the agent at the bundle; get long-polls the combined
 * content version so clients pull updates as they happen — long-poll rather
 * than push so child instances stream through the request/response tunnel
 * unchanged. Bundle ids and member names are single sanitized segments, so
 * no client-supplied path can escape the spec root. */

const SPEC_ROOT = "docs/superpowers/specs";
const BUNDLE_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;
const MEMBER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function bundleIdFrom(p: Record<string, unknown>): string {
  if (typeof p.bundle === "string") {
    if (!BUNDLE_ID.test(p.bundle) || p.bundle.length > 80) {
      throw new BrokerError("bad_request", "'bundle' must be a YYYY-MM-DD-name id ([a-z0-9-])");
    }
    return p.bundle;
  }
  const slug = str(p.name, "name").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 64) throw new BrokerError("bad_request", "'name' must slug to 1-64 chars of [a-z0-9-]");
  return `${new Date().toISOString().slice(0, 10)}-${slug}`;
}

function memberName(v: unknown, key: string): string {
  const name = str(v, key);
  if (!MEMBER_NAME.test(name) || name.length > 64) {
    throw new BrokerError("bad_request", `'${key}' must be a bundle file name ([a-zA-Z0-9._-], no path)`);
  }
  return name;
}

interface BundleMember {
  size: number;
  content: string;
  truncated?: boolean;
  binary?: boolean;
}

function readBundle(cwd: string, bundle: string): { files: Record<string, BundleMember>; version: string } | undefined {
  const dir = join(cwd, SPEC_ROOT, bundle);
  if (!existsSync(dir)) return undefined;
  const files: Record<string, BundleMember> = {};
  const hash = createHash("sha256");
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    const buf = readFileSync(join(dir, name));
    hash.update(name).update(":").update(createHash("sha256").update(buf).digest("hex")).update("\n");
    files[name] = capText(buf);
  }
  return { files, version: hash.digest("hex") };
}

async function specTarget(deps: OpsDeps, session: string, pane: string): Promise<{ target: string; cwd: string; workspaceId: string }> {
  const { entry } = await agentInPane(deps, session, pane);
  const target = typeof entry.name === "string" && entry.name ? entry.name : String(entry.agent ?? "");
  if (!target) throw new BrokerError("upstream_error", `agent in pane '${pane}' has no addressable name`);
  const workspaceId = pane.split(":")[0];
  return { target, cwd: await resolveCwd(deps, session, workspaceId), workspaceId };
}

async function specDrive(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const pane = str(p.pane_id, "pane_id");
  const prompt = str(p.prompt, "prompt");
  const bundle = bundleIdFrom(p);
  const focus = p.file === undefined ? undefined : memberName(p.file, "file");
  const { target, cwd, workspaceId } = await specTarget(deps, session, pane);
  const dir = `${SPEC_ROOT}/${bundle}`;
  mkdirSync(join(cwd, dir), { recursive: true });
  const overview = join(cwd, dir, "overview.md");
  if (!existsSync(overview)) writeFileSync(overview, `# ${bundle.slice(11)}\n\n_Drafting…_\n`);
  const questionsIn = focus ?? "overview.md";
  const contextLine = activeContextPreamble(cwd);
  const text =
    (contextLine ? `${contextLine}\n\n` : "") +
    `You maintain the spec bundle at ${dir}/ (relative to ${cwd}) — a set of design files. ` +
    `overview.md is the entry point; add files as the design needs them (api.md, data-model.md, ` +
    `diagrams as mermaid in markdown).\n\n` +
    (focus ? `The human is currently viewing ${dir}/${focus} — apply this instruction to that file, touching others only when required.\n\n` : "") +
    `Instruction: ${prompt}\n\n` +
    `Update the files incrementally and save often. If you need decisions from the human, list them under ` +
    `an '## Open questions' section in ${questionsIn}. The files are the deliverable — do not answer in the terminal.`;
  await deps.local.request(session, "agent.prompt", { target, text }, 30_000);
  const b = readBundle(cwd, bundle)!;
  return { workspace_id: workspaceId, bundle, dir, files: Object.keys(b.files), version: b.version, status: "prompted" };
}

async function specPlan(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const pane = str(p.pane_id, "pane_id");
  const bundle = bundleIdFrom(p);
  const extra = typeof p.prompt === "string" && p.prompt.trim() ? p.prompt.trim() : undefined;
  const { target, cwd, workspaceId } = await specTarget(deps, session, pane);
  const dir = `${SPEC_ROOT}/${bundle}`;
  if (!existsSync(join(cwd, dir))) {
    throw new BrokerError("unknown_bundle", `no spec bundle '${bundle}' in this workspace`);
  }
  const text =
    `The spec bundle at ${dir}/ (relative to ${cwd}) is ready for planning. Read every file in it, then ` +
    `write the implementation plan to ${dir}/plan.md — concrete stages, the files each stage touches, and ` +
    `a test strategy per stage. Keep updating plan.md as you refine it.` +
    (extra ? ` Additional guidance: ${extra}` : "");
  await deps.local.request(session, "agent.prompt", { target, text }, 30_000);
  return { workspace_id: workspaceId, bundle, dir, file: "plan.md", status: "prompted" };
}

async function specGet(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const workspaceId = str(p.workspace_id, "workspace_id");
  const bundle = bundleIdFrom(p);
  const cwd = await resolveCwd(deps, session, workspaceId);
  const known = typeof p.version === "string" ? p.version : undefined;
  const waitMs = Math.min(Math.max(typeof p.wait_ms === "number" ? p.wait_ms : 0, 0), 30_000);
  const pollMs = deps.filePollMs ?? 500;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const b = readBundle(cwd, bundle);
    if (!b) throw new BrokerError("unknown_bundle", `no spec bundle '${bundle}' in this workspace`);
    if (!known || b.version !== known) {
      return { workspace_id: workspaceId, bundle, dir: `${SPEC_ROOT}/${bundle}`, version: b.version, files: b.files };
    }
    if (Date.now() >= deadline) return { workspace_id: workspaceId, bundle, version: b.version, unchanged: true };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function specList(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const workspaceId = str(p.workspace_id, "workspace_id");
  const cwd = await resolveCwd(deps, session, workspaceId);
  const root = join(cwd, SPEC_ROOT);
  if (!existsSync(root)) return { workspace_id: workspaceId, bundles: [] };
  const bundles = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && BUNDLE_ID.test(e.name))
    .map((e) => e.name)
    .sort()
    .map((bundle) => ({
      bundle,
      files: readdirSync(join(root, bundle), { withFileTypes: true })
        .filter((f) => f.isFile() && !f.name.startsWith("."))
        .map((f) => f.name)
        .sort(),
    }));
  return { workspace_id: workspaceId, bundles };
}

type AnswerRead =
  | { kind: "ok"; answer: unknown }
  | { kind: "oversize"; raw: string; full_bytes: number }
  | { kind: "parse_error"; raw: string };

/** Reads the answer file, applying the 768KB cap (spec §6) before parsing —
 * a valid answer over the cap is a size condition, not a syntax one, so it
 * must never fall through to parse_error. */
function readAnswerFile(file: string): AnswerRead {
  const size = statSync(file).size;
  const buf = readFileSync(file);
  if (size > DIFF_CAP_BYTES) {
    return { kind: "oversize", raw: buf.subarray(0, DIFF_CAP_BYTES).toString("utf8"), full_bytes: size };
  }
  try {
    return { kind: "ok", answer: JSON.parse(buf.toString("utf8")) };
  } catch {
    return { kind: "parse_error", raw: buf.toString("utf8") };
  }
}

function toAskResult(res: AnswerRead): unknown {
  if (res.kind === "ok") {
    // The contract asks for {"answer": <payload>} — unwrap the envelope so
    // clients get a deterministic shape; a non-conforming file (older
    // agents, freeform output) still comes back verbatim under `answer`.
    const a = res.answer;
    if (a !== null && typeof a === "object" && !Array.isArray(a) && "answer" in a) {
      return { answer: (a as Record<string, unknown>).answer };
    }
    return { answer: a };
  }
  if (res.kind === "oversize") return { answer: null, raw: res.raw, truncated: true, full_bytes: res.full_bytes };
  return { answer: null, raw: res.raw, parse_error: true };
}

/** File-drop handshake (spec §2.5): the answer travels through the
 * filesystem the agent and this process share — never through the terminal
 * renderer. The registry's pane status provides an early exit when the
 * agent finishes without writing. */
async function ask(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const pane = str(p.pane_id, "pane_id");
  const prompt = str(p.prompt, "prompt");
  // One ask at a time per pane: a second concurrent ask would interleave
  // answer contracts at the agent. Steering (prompt/slash/model) stays
  // unblocked — mid-ask redirection is a feature, not a conflict.
  const lockKey = `${session}:${pane}`;
  deps.askLocks ??= new Set();
  if (deps.askLocks.has(lockKey)) {
    throw new BrokerError("pane_busy", `an ask is already in flight on pane '${pane}' — one ask at a time per pane`, {
      pane_id: pane,
    });
  }
  deps.askLocks.add(lockKey);
  let result: unknown;
  try {
    result = await askInner(deps, session, pane, prompt, p);
  } finally {
    deps.askLocks.delete(lockKey);
  }
  // AFTER the lock, deliberately: a handler reacting to this may want to
  // ask again on the same pane, and emitting inside the try would hand it
  // a pane_busy it could not avoid.
  deps.events?.emit("broker.ask.completed", { pane_id: pane });
  return result;
}

/** A repo can commit `.herdr` itself — or a subdir under it, like
 * `.herdr/answers` — as a symlink pointing outside the workspace. Checked
 * BEFORE any mkdir/write touches `dir`, not after: whichever path segment
 * already exists is the one an attacker controls, so that segment is what
 * has to be resolved and compared. Checking `dir` alone misses an
 * already-malicious `.herdr` whose child (`answers`/`exits`) is still
 * missing — mkdirSync would then create that child, and any sibling write
 * (e.g. execCommand's .gitignore), THROUGH the symlink before an
 * escape-after-the-fact check ever ran. A `dir` with no existing ancestor
 * below `cwd` has nothing to escape through yet — mkdirSync creates it
 * fresh afterward. */
function assertWithinWorkspace(cwd: string, dir: string, label: string): void {
  let probe = dir;
  while (!existsSync(probe)) probe = dirname(probe);
  const realProbe = realpathSync(probe);
  const realCwd = realpathSync(cwd);
  if (realProbe !== realCwd && !realProbe.startsWith(realCwd + sep)) {
    throw new BrokerError("unknown_workspace", `workspace ${label} dir escapes the workspace`);
  }
}

async function askInner(
  deps: OpsDeps,
  session: string,
  pane: string,
  prompt: string,
  p: Record<string, unknown>,
): Promise<unknown> {
  const budget = Math.min(Math.max(typeof p.timeout_ms === "number" ? p.timeout_ms : 120_000, 1_000), 600_000);
  const workspaceId = pane.split(":")[0];
  const cwd = await resolveCwd(deps, session, workspaceId);

  const raw = (await deps.local.request(session, "agent.list", {}, 10_000)) as {
    agents?: Array<Record<string, unknown>>;
  };
  const entry = raw.agents?.find((a) => a.pane_id === pane);
  if (!entry) throw new BrokerError("bad_request", `no agent in pane '${pane}'`);
  const target = typeof entry.name === "string" && entry.name ? entry.name : String(entry.agent ?? "");
  if (!target) throw new BrokerError("upstream_error", `agent in pane '${pane}' has no addressable name`);

  const id = randomBytes(8).toString("hex");
  const dir = join(cwd, ".herdr", "answers");
  // spec §2.5 step 5 — checked before mkdirSync, not after.
  assertWithinWorkspace(cwd, dir, "answers");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.json`);
  const contextLine = activeContextPreamble(cwd);
  const text =
    (contextLine ? `${contextLine}\n\n` : "") +
    `${prompt}\n\n` +
    `When you are finished, write ONLY a JSON object of the form ` +
    `{"answer": <your answer as JSON>} to the file ` +
    `.herdr/answers/${id}.json (relative to ${cwd}). ` +
    `The file must contain valid JSON and nothing else.`;
  await deps.local.request(session, "agent.prompt", { target, text }, 30_000);

  const pollMs = deps.askPollMs ?? 500;
  const graceMs = deps.askGraceMs ?? 10_000;
  const startGraceMs = deps.askStartGraceMs ?? 15_000;
  const startedAt = Date.now();
  const deadline = startedAt + budget;
  // meta/profile can't change mid-ask — resolved once here, not on every
  // poll: deps.agents.get() re-reads agents.json from disk each call, and
  // this loop can run ~1200 times over a full budget.
  const meta = deps.agents.get(session, pane);
  const profile = meta ? deps.profiles.get(meta.kind) : undefined;
  let sawWorking = false;
  let idleSince: number | undefined;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const res = readAnswerFile(file);
      if (res.kind !== "parse_error") {
        rmSync(file, { force: true });
        return toAskResult(res);
      }
      // possibly mid-write — keep polling; the deadline or the status
      // grace decides when to give up and report parse_error
    }
    const t = meta && profile ? readTurnState(profile, meta, cwd, undefined, deps.stateDir) : null;
    const tierStatus = deps.registry.get("runtime")?.sessions[session]?.agents.find((a) => a.id === pane)?.status;
    const decision = decideTurn(t, { status: tierStatus ?? "idle" }, startedAt);
    const status = decision.status;
    if (status === "working" || status === "blocked") {
      // blocked (e.g. an approval prompt) is not idle — the agent may still
      // resume and write the answer, so it must not start the countdown.
      sawWorking = true;
      idleSince = undefined;
    } else if (sawWorking) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince > graceMs) break;
    } else if (Date.now() - startedAt > startGraceMs) {
      // The pane's status folds "unknown"/"done" to idle, so a dead-but-
      // listed agent looks idle and would otherwise hang for the whole
      // budget on its first ask — fail fast with a distinct code instead.
      // The message states which basis was measured. On the status tier
      // that's "agent_status never became working" (today's behavior,
      // unchanged). On the transcript tier, reaching this throw requires
      // status === "idle" on every poll, which for evidence === "transcript"
      // only happens when the transcript itself says the turn is DONE — so
      // the agent didn't fail to start, it finished without ever writing
      // the answer file. Same code (failing fast is still right — a
      // completed turn with no answer file will never produce one), a
      // message that says what was actually observed.
      // Carries `evidence`, which is the clearest case for the broker.*
      // layer existing: a handler can tell a transcript-proven stall from
      // an inferred one, and no herdr event can express that.
      deps.events?.emit("broker.ask.unresponsive", { pane_id: pane, evidence: decision.evidence });
      throw new BrokerError(
        "agent_unresponsive",
        decision.evidence === "transcript"
          ? `agent in pane '${pane}' finished its turn (per its own transcript) but wrote no answer file within ${startGraceMs}ms`
          : `agent in pane '${pane}' never started working within ${startGraceMs}ms — it may be dead or stuck`,
        { pane_id: pane, evidence: decision.evidence },
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (existsSync(file)) {
    // One last parse attempt: the file may have finished landing in the gap
    // between the loop's last poll and this check — a late-but-valid answer
    // must not be discarded as a parse_error.
    const res = readAnswerFile(file);
    rmSync(file, { force: true });
    return toAskResult(res);
  }
  throw new BrokerError("upstream_timeout", `agent produced no answer within ${budget}ms`, { pane_id: pane });
}

/** Run a command in the pane and learn whether it SUCCEEDED, not merely
 * that it finished. herdr's agent.start owns the agent's own process
 * launch, so there is no agent command line for the broker to wrap; this
 * answers the question for commands instead — the CI-shaped case
 * (this repo's own validate.sh, say). "Finished" and "succeeded" are
 * different questions; only the shell's own $? tells them apart, so the
 * wrapped command writes it to a drop file we poll for.
 *
 * Same discipline as ask()'s answer file, including its symlink-escape
 * guard: a repo that commits .herdr/exits as a symlink pointing outside
 * the workspace must not let us read/write through it. */
async function execCommand(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  const pane = str(p.pane_id, "pane_id");
  const command = str(p.command, "command");
  if (command.length > 8_000) throw new BrokerError("bad_request", "'command' must be at most 8000 chars");
  if (/[\r\n]/.test(command)) throw new BrokerError("bad_request", "'command' must be a single line");
  const budget = Math.min(Math.max(typeof p.timeout_ms === "number" ? p.timeout_ms : 120_000, 1_000), 600_000);
  const workspaceId = pane.split(":")[0];
  const cwd = await resolveCwd(deps, session, workspaceId);

  const id = randomBytes(8).toString("hex");
  const dir = join(cwd, ".herdr", "exits");
  // Same guard as askInner, checked before mkdirSync/writeFileSync touch
  // anything — a .herdr (or .herdr/exits) symlinked outside the workspace
  // must not get a directory created or a .gitignore written through it.
  assertWithinWorkspace(cwd, dir, "exits");
  mkdirSync(dir, { recursive: true });
  // .herdr/.gitignore ("*") is otherwise only written by context-store.ts's
  // ensureDir, and only once a context attachment is created — a fresh
  // workspace with none won't have it yet. Write it here too so exit drop
  // files never show up in the user's git status.
  const ignore = join(cwd, ".herdr", ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  const file = join(dir, id);
  await deps.local.request(
    session,
    "pane.send_input",
    { pane_id: pane, text: `${command}; echo $? > .herdr/exits/${id}`, keys: ["Enter"] },
    10_000,
  );

  // undefined covers both "no file yet" and "file mid-write" (a partial
  // write like "" or "0\n0" doesn't parse to an integer) — both cases
  // mean keep polling, never that the command failed.
  const readCode = (): number | undefined => {
    if (!existsSync(file)) return undefined;
    const code = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(code) ? code : undefined;
  };

  const pollMs = deps.askPollMs ?? 500;
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const code = readCode();
    if (code !== undefined) {
      rmSync(file, { force: true });
      return { pane_id: pane, exit_code: code, ok: code === 0 };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // One last check, mirroring askInner: the file may have finished landing
  // in the gap between the loop's last poll and this check — a command
  // that finishes right as the budget runs out must not be reported as a
  // timeout just because no poll happened to land after it.
  const code = readCode();
  rmSync(file, { force: true });
  if (code !== undefined) {
    deps.events?.emit("broker.exec.finished", { pane_id: pane, exit_code: code, ok: code === 0 });
    return { pane_id: pane, exit_code: code, ok: code === 0 };
  }
  throw new BrokerError("upstream_timeout", `command produced no exit code within ${budget}ms`, { pane_id: pane });
}
