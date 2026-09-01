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
import type { AgentIndex, ResumableIndex, WorkspaceIndex } from "./state.js";
import type { CliProfile, CliProfiles } from "./cli-profiles.js";
import { prepareWorkspace, trustProject } from "./prepare-workspace.js";
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
  /** conversations whose pane is gone but which a CLI can still resume
   * (roadmap 31b) — see ResumableIndex */
  resumable: ResumableIndex;
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
      // IDEMPOTENT (roadmap 32). herdr reaps a workspace when its last pane
      // closes, which `DELETE .../agents/{pane}` routinely causes, so by the
      // time a caller cleans up the workspace is often already gone. This
      // used to await herdr FIRST and let workspace_not_found throw past the
      // two index removals below — leaving a row that no API call could ever
      // remove, since these are the only two sites that remove one, and
      // listWorkspaces unions the index with herdr's live set and reported it
      // as a real workspace forever after. Observed 4 of 4 WT-11 runs.
      // An id NEITHER side knows still errors — see below.
      //
      // Not-found means the goal state ALREADY HOLDS, so it is a success for
      // index purposes — but only when the broker HAS a row for it. That
      // condition is what keeps a typo an error: an id neither side knows is
      // simply unknown, and answering success would tell a caller it had
      // reaped something that never existed. A row on this side and nothing
      // on herdr's is the reaped case, and the row is ours to clear.
      //
      // Narrow on the code too: any other failure still throws and still
      // leaves the row, because dropping one while the workspace lives is the
      // worse direction — the broker would forget the cwd of running panes.
      let alreadyClosed = false;
      try {
        // Wire-verified herdr surface (schema probe 2026-08-21): closes the
        // workspace and every pane in it — the mode-B leak's cleanup path.
        await deps.local.request(session, "workspace.close", { workspace_id: workspaceId }, 15_000);
      } catch (e) {
        if (!(e instanceof BrokerError) || e.code !== "workspace_not_found") throw e;
        if (deps.index.get(session, workspaceId) === undefined) throw e;
        alreadyClosed = true;
      }
      // Every agent row for this workspace dies with it — a pane id herdr
      // later reuses must not inherit a stale kind/sessionId pointing a
      // transcript read at a previous agent that no longer exists. The
      // CONVERSATIONS outlive the panes though (roadmap 31b), so each one is
      // archived on the way out. herdr's own `workspace.closed` event may be
      // racing this very call; reapWorkspaceRow is why that is safe.
      reapWorkspaceRow(deps, session, workspaceId);
      // `closed` is the POSTCONDITION, not a report of who did it: an
      // idempotent delete whose goal state holds must not answer false, which
      // a caller would read as failure and retry. `already_closed` carries
      // the distinction for anyone who wants it. This deliberately reads
      // differently from the git verbs (`{committed:false, clean:true}`),
      // where false means the thing you expected to exist does not.
      return { workspace_id: workspaceId, closed: true, already_closed: alreadyClosed };
    }
    case "broker.workspace.list":
      return listWorkspaces(deps, session);
    // Report-never-reap surface (see classifySession): live workspaces the
    // broker has no index row for. Kills nothing — pure inspection.
    case "broker.session.orphans": {
      const live = [...(await herdrWorkspaces(deps, session)).keys()];
      return { session, ...classifySession(deps.index.all(session), live) };
    }
    // Conversations whose agent is gone and whose CLI can still reattach.
    // The answer to roadmap 31(a): the broker mints these ids and this is
    // where a caller can finally see one.
    case "broker.session.resumable":
      return { session, resumable: deps.resumable.all(session) };
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
      // Deliberately NOT archived as resumable, unlike workspace.close: this
      // call DELETES the checkout, and a conversation whose directory is gone
      // cannot be resumed — the CLI keys its transcript on that path. An
      // entry here would list a conversation that fails the moment anyone
      // picks it.
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

/** Archive a workspace's conversations, then drop its index row. Returns
 * whether the broker actually HELD a row for it.
 *
 * The one sequence, three callers — `broker.workspace.close`, the reaped-
 * workspace self-heal in `stopAgent`, and the `workspace.closed` event
 * handler (roadmap 31f). They race by construction: herdr emits
 * `workspace.closed` the instant it closes one, so the event can land in the
 * middle of the close call that caused it. Sharing this makes the race
 * harmless — whichever arrives first performs the WHOLE job, and the loser
 * finds an empty `removeWorkspace` and a row already gone.
 *
 * Splitting it is what would break: a handler that only removed the row
 * could win the race between the close call's herdr round trip and its
 * archiving, taking the cwd away first. `resumable.record` drops any
 * conversation it cannot pair with a cwd, and drops it SILENTLY, so resume
 * would quietly stop working with nothing failing anywhere.
 *
 * Deliberately NOT used by `broker.worktree.remove`: that call deletes the
 * checkout, and a conversation whose directory is gone cannot be resumed —
 * it removes the agent rows without archiving, on purpose. */
export function reapWorkspaceRow(deps: OpsDeps, session: string, workspaceId: string): boolean {
  // Read BEFORE removing: index.remove takes the cwd away, and the cwd is
  // what makes an archived conversation resumable.
  const meta = deps.index.get(session, workspaceId);
  for (const m of deps.agents.removeWorkspace(session, workspaceId)) {
    deps.resumable.record(session, m, meta?.cwd, meta?.label);
  }
  deps.index.remove(session, workspaceId);
  return meta !== undefined;
}

/** Opportunistic herdr workspace.list. Degrades to an empty map when the
 * method is missing or the call fails, so there is one code path either way.
 *
 * On CWD, specifically: herdr does not supply one here. Verified 2026-08-31
 * against a live 0.8.2 (protocol 20) — `WorkspaceInfo` declares
 * {workspace_id, number, label, focused, pane_count, tab_count,
 * active_tab_id, agent_status} and no `cwd`, while `AgentInfo` and
 * `PaneInfo` both carry one. A snapshot of a real workspace agrees.
 *
 * So the `w.cwd` read below is belt-and-braces against a future herdr that
 * adds the field, NOT a live source: today it is always undefined, and the
 * WorkspaceIndex is the SOLE source of cwd rather than a fallback. Kept
 * because reading a field that isn't there costs nothing and adopting one
 * that appears costs nothing either. `label` IS supplied and is used.
 *
 * The distinction matters for anyone tempted to "fix" a wrong cwd by
 * trusting herdr's: there is nothing there to trust. */
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

/** Does herdr still have this workspace? The WRITER's counterpart to
 * herdrWorkspaces, and deliberately not built on it.
 *
 * herdrWorkspaces degrades to an EMPTY MAP when the call fails or the method
 * is absent, which is right for its three readers — they fall back to the
 * index and keep working. A writer cannot use that contract: an empty map
 * means both "herdr reaped everything" and "herdr never answered", and acting
 * on the second erases the index of a herdr that merely lacks
 * `workspace.list` (0.8.0 does), turning a degraded-but-working setup into
 * total data loss.
 *
 * So this answers THREE states, not two:
 *   true       herdr answered and still lists it   -> LIVE
 *   false      herdr answered and does not         -> REAPED
 *   undefined  herdr did not answer                -> NO OPINION
 */
async function workspaceStillLive(
  deps: OpsDeps,
  session: string,
  workspaceId: string,
): Promise<boolean | undefined> {
  const res = (await deps.local.request(session, "workspace.list", {}, 5000).catch(() => undefined)) as
    | { workspaces?: Array<Record<string, unknown>> }
    | undefined;
  if (!Array.isArray(res?.workspaces)) return undefined;
  return res.workspaces.some((w) => w.workspace_id === workspaceId);
}

/** The ONE cwd lookup, shared by every caller: herdr's own view first, the
 * broker's index behind it.
 *
 * "Behind it" is currently "instead of": herdr's workspace records carry no
 * cwd (see herdrWorkspaces, verified against 0.8.2/protocol 20), so the left
 * side of the ?? is always undefined and the index answers every call. The
 * ordering stays so a herdr that starts reporting cwd wins automatically.
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

/** Attach `evidence` to a whole roster — OPT-IN, roadmap 25(c).
 *
 * `GET .../agents` is a free registry read: push-fed, no disk, no herdr, and
 * the endpoint a UI polls most. Evidence costs a transcript read PER AGENT —
 * a 256KB tail for claude, two file reads for agy, a SQLite open/query/close
 * for opencode — so it is paid only when a caller asks, the same way
 * `?fresh=1` on this handler already trades a round trip for freshness.
 *
 * The one `workspace.list` is hoisted out of the loop: cwd resolution is
 * per-workspace, not per-agent, so N agents in one workspace cost one call.
 *
 * `promptedAt` is the agent's own `startedAt`, not a turn boundary. A roster
 * has no turn — the question it answers is "has this agent produced a
 * transcript record since it started", which is the per-AGENT bound. See
 * readTurnState's own note on the two bounds being different things.
 *
 * Callers must not run this for a federated instance: the child's transcripts
 * are on the CHILD's disk, so every read would miss and every agent would
 * report "status" — indistinguishable from "computed, found nothing". The
 * route leaves `evidence` absent there instead. */
export async function withEvidence<T extends { id: string; status: string; raw_status?: string }>(
  deps: OpsDeps,
  session: string,
  agents: T[],
): Promise<Array<T & { evidence: "transcript" | "status" }>> {
  const fromHerdr = await herdrWorkspaces(deps, session);
  return agents.map((a) => {
    const ws = a.id.split(":")[0];
    const cwd = fromHerdr.get(ws)?.cwd ?? deps.index.get(session, ws)?.cwd;
    const meta = deps.agents.get(session, a.id);
    const profile = meta ? deps.profiles.get(meta.kind) : undefined;
    const t = meta && profile && cwd ? readTurnState(profile, meta, cwd, undefined, deps.stateDir) : null;
    const d = decideTurn(t, { status: foldStatus(a.status), raw_status: a.raw_status }, meta?.startedAt ?? 0);
    return { ...a, status: d.status, raw_status: d.raw_status, evidence: d.evidence };
  });
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
/** Render a CLI's resume flag. The three styles are real differences
 * observed across the manifest set, not speculation about future ones —
 * `claude --resume <id>`, `copilot --resume=<id>`, `codex resume <id>` —
 * which is why the profile stores the shape rather than assuming one.
 * `extraArgs` follows the id (claude's --fork-session lives there). */
function renderResume(r: NonNullable<CliProfile["resume"]>, sessionId: string): string[] {
  const head =
    r.style === "equals"
      ? [`${r.flag}=${sessionId}`]
      : r.style === "subcommand"
        ? [r.flag, sessionId]
        : [r.flag, sessionId];
  return [...head, ...(r.extraArgs ?? [])];
}

interface ResumeTarget {
  sessionId: string;
  kind: string;
  cwd: string;
  profile: CliProfile;
}

/** Resolve `resume: {session_id}` or `resume: {pane_id}` to a conversation.
 *
 * Two forms because there are two moments you want this. `session_id` reads
 * the archive and is the one that matters — resume is wanted precisely when
 * the agent is GONE, which is when its pane row no longer exists. `pane_id`
 * is the convenience for an agent still on screen, resolved from the live
 * index. Both end at the same place: an id, a kind, and the directory the
 * conversation belongs to. */
function resolveResume(deps: OpsDeps, session: string, p: Record<string, unknown>): ResumeTarget | undefined {
  if (p.resume === undefined) return undefined;
  const r = p.resume as Record<string, unknown> | null;
  const bySession = typeof r?.session_id === "string" ? r.session_id : undefined;
  const byPane = typeof r?.pane_id === "string" ? r.pane_id : undefined;
  if (!bySession === !byPane) {
    throw new BrokerError("bad_request", "'resume' needs exactly one of 'session_id' and 'pane_id'");
  }

  let sessionId: string;
  let kind: string;
  let cwd: string | undefined;
  if (bySession) {
    const row = deps.resumable.get(session, bySession);
    if (!row) {
      throw new BrokerError("unknown_session_ref", `no resumable conversation '${bySession}' in session '${session}'`);
    }
    ({ sessionId, kind, cwd } = row);
  } else {
    const meta = deps.agents.get(session, byPane as string);
    if (!meta) throw new BrokerError("bad_request", `no agent recorded for pane '${byPane as string}'`);
    if (!meta.sessionId) {
      throw new BrokerError(
        "bad_request",
        `the agent in pane '${byPane as string}' (${meta.kind}) has no pinned session id, so there is ` +
          "nothing to resume BY — only kinds with a `pin` in cli-profiles.ts can be resumed",
      );
    }
    sessionId = meta.sessionId;
    kind = meta.kind;
    cwd = deps.index.get(session, (byPane as string).split(":")[0])?.cwd;
    if (!cwd) throw new BrokerError("bad_request", `no recorded cwd for pane '${byPane as string}'`);
  }

  const profile = deps.profiles.get(kind);
  // Absent rather than guessed, same rule as `transcript`. Sending an
  // unverified flag is how WT-2's agy result happens: accepted, honored by
  // nothing, and indistinguishable from a real resume until someone asks the
  // agent something only the old conversation knew.
  if (!profile?.resume) {
    throw new BrokerError(
      "resume_unsupported",
      `'${kind}' has no verified resume syntax, so the broker will not guess one. Kinds gain a ` +
        "`resume` profile entry only once a wire probe has watched it reattach (WT-11).",
    );
  }
  return { sessionId, kind, cwd: cwd as string, profile };
}

async function spawn(deps: OpsDeps, session: string, p: Record<string, unknown>): Promise<unknown> {
  // Mode D (roadmap 31): reattach an existing conversation instead of
  // starting a fresh one. NOT a fourth placement mode — a resumed agent
  // still needs a pane, so this composes with A/B/C rather than replacing
  // them. What it adds is WHICH conversation, and a cwd when the caller
  // does not name one.
  const resumeReq = resolveResume(deps, session, p);
  const kind = resumeReq ? resumeReq.kind : str(p.kind, "kind");
  const hasCwd = typeof p.cwd === "string";
  const hasWs = typeof p.workspace_id === "string";
  if (hasCwd === hasWs && !(resumeReq && !hasCwd && !hasWs)) {
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
  if (resumeReq && !hasCwd && !hasWs) {
    // The conversation's own directory. Defaulting rather than demanding it
    // keeps the common case one field: you resume by id and land where the
    // conversation lived.
    cwd = resumeReq.cwd;
  } else if (!hasWs) {
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

  // A resume into the WRONG directory is the failure this guards. claude
  // stores transcripts under a slug of the cwd, so `--resume <id>` from
  // elsewhere does not reattach — it starts a fresh conversation wearing an
  // old id, which looks exactly like success from every angle the broker can
  // see. Refuse instead of producing a convincing lie.
  if (resumeReq && cwd !== resumeReq.cwd) {
    throw new BrokerError(
      "bad_request",
      `cannot resume session '${resumeReq.sessionId}' from '${cwd}': the conversation happened in ` +
        `'${resumeReq.cwd}', and this CLI keys its transcripts on the directory. Omit 'cwd' and ` +
        "'workspace_id' to resume where it lived.",
    );
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

  // Per-DIRECTORY trust, written now that the EFFECTIVE cwd is known.
  //
  // This cannot ride prepareWorkspace above. That call has to happen before
  // the pane exists, because the env var it returns is injected at pane
  // creation — and mode C's checkout path does not exist until
  // worktree.create has returned, which is the branch above. Mode C is also
  // the case that needs this most: an isolated checkout is a new path by
  // construction, so every mode-C spawn meets the dialog on a directory no
  // prior spawn can have trusted.
  //
  // Same degrade contract as prepareWorkspace, for the same reasons (a
  // read-only stateDir, a cli-config dir the broker doesn't own): a trust
  // convenience must never fail a spawn that would otherwise succeed. The
  // CLI's own first-run dialog reappears, exactly as before this existed.
  try {
    trustProject(deps.profiles.get(kind) ?? { kind, source: "builtin" }, deps.stateDir, worktreeMade?.path ?? cwd);
  } catch {
    // intentionally ignored — see above
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
  // Mode D's argv. The pin above is KEPT deliberately: WT-11 showed the fork
  // lands under the id the broker just minted, so AgentMeta.sessionId goes on
  // pointing at the live record and nothing has to be re-captured after
  // spawn. Suppressing the pin instead would have forced the broker to adopt
  // an id it did not mint, giving up the launch-time-known path that is the
  // whole reason `pin` exists.
  if (resumeReq) {
    args = [...(args ?? []), ...renderResume(resumeReq.profile.resume!, resumeReq.sessionId)];
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
    // The same lookup ask uses — herdr's view first, index behind it (in
    // practice the index, which is the only side carrying cwd) — so
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
  // Its CONVERSATION does not end with the pane, though: archive it first,
  // which is the whole of roadmap 31(b). This is the moment resume exists
  // for — an agent that stopped is exactly the one you want back.
  const ended = deps.agents.remove(session, pane);
  const wsId = pane.split(":")[0];
  const ws = deps.index.get(session, wsId);
  if (ended) deps.resumable.record(session, ended, ws?.cwd, ws?.label);

  // Roadmap 32's remaining half. herdr reaps a workspace when its last pane
  // closes, and the pane.close above is routinely what closes it — so this is
  // the only site that can notice. `deps.index.remove` is reached from just
  // two places (broker.workspace.close, broker.worktree.remove) and a client
  // that manages AGENTS has no reason to call either. Left alone the row is
  // advertised by listWorkspaces forever, and every mode-B spawn into that id
  // dies on `pane_not_found` permanently.
  //
  // Deliberately AFTER the archive above: resumable.record needs the cwd this
  // row holds, and silently drops any conversation it cannot pair with one.
  // Only a DEFINITE no from herdr acts. `undefined` is "no opinion", and it
  // has to stay inert: a herdr without `workspace.list` (0.8.0) answers that
  // way for every workspace it owns, so treating it as "reaped" would erase
  // the whole index of a setup that works fine today — a far worse bug than
  // the one being fixed, and the same trap that makes herdrWorkspaces the
  // wrong helper to build this on.
  if ((await workspaceStillLive(deps, session, wsId)) === false) {
    try {
      // The same cleanup broker.workspace.close performs, for its reasons.
      // herdr took every pane in the workspace with it, so an agent row left
      // behind is a transcript pointer at a pane id herdr is free to reuse —
      // exactly what AgentIndex.removeWorkspace exists to prevent. Clearing
      // the workspace row but not these would be the worst of the three
      // options: it keeps the stale-pointer bug while reporting the
      // workspace tidied. The conversations outlive the panes, so each one
      // is archived on the way out (roadmap 31b); `ws` was read above, so
      // the cwd they are keyed on is still in hand.
      reapWorkspaceRow(deps, session, wsId);
    } catch {
      // The agent IS stopped: pane.close succeeded and its row is already
      // gone. Bookkeeping trouble here — a read-only stateDir, the same
      // class of failure prepareWorkspace and trustProject degrade on above
      // — must not report that as a failed stop, because the caller's retry
      // can only answer `no agent in pane` for a pane that is genuinely
      // closed. Same postcondition reasoning as workspace.close's
      // `closed: true`. The row survives to be cleared by the next stop in
      // that workspace, or by an explicit DELETE .../workspaces/{id}.
    }
  }

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
