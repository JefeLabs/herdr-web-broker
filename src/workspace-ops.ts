import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type { EnvRegistry } from "./env-registry.js";
import { BrokerError } from "./errors.js";
import type { ModelRegistry } from "./model-registry.js";
import { DIFF_CAP_BYTES, discoverRepos, repoDiff, repoTree, resolveRepo } from "./git-exec.js";
import type { LocalHerdr } from "./local-attach.js";
import type { Registry } from "./registry.js";
import type { WorkspaceIndex } from "./state.js";

export interface OpsDeps {
  local: LocalHerdr;
  registry: Registry;
  index: WorkspaceIndex;
  env: EnvRegistry;
  models: ModelRegistry;
  /** test overrides for broker.agent.ask pacing */
  askPollMs?: number;
  askGraceMs?: number;
  /** how long ask() waits for the agent to start working before failing fast */
  askStartGraceMs?: number;
  /** test override for post-injection shell settle */
  envSettleMs?: number;
  /** cold-pane agent.start retry pacing (agent_pane_busy) */
  paneBusyRetries?: number;
  paneBusyDelayMs?: number;
  /** test override for spec-bundle long-poll pacing */
  filePollMs?: number;
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
    case "broker.repo.file":
      return repoFile(deps, session, p);
    case "broker.agent.spawn":
      return spawn(deps, session, p);
    case "broker.agent.ask":
      return ask(deps, session, p);
    case "broker.agent.model":
      return switchModel(deps, session, p);
    case "broker.agent.slash":
      return slash(deps, session, p);
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

  // Env spec §5: resolve first — a failing hook must not leave an orphan
  // workspace behind.
  const injected = await deps.env.resolveForSpawn(session, kind);

  const created = (await deps.local.request(session, "workspace.create", { cwd, ...(label ? { label } : {}) }, 15_000)) as {
    root_pane?: { pane_id?: unknown };
  };
  const paneId = typeof created?.root_pane?.pane_id === "string" ? created.root_pane.pane_id : undefined;
  if (!paneId || !paneId.includes(":")) {
    throw new BrokerError("upstream_error", "workspace.create returned no root pane");
  }
  const workspaceId = paneId.split(":")[0];
  deps.index.set(session, workspaceId, { cwd, ...(label ? { label } : {}) });

  if (Object.keys(injected).length > 0) {
    const drop = deps.env.writeDropFile(injected);
    try {
      await deps.local.request(
        session,
        "pane.send_input",
        // Source-and-delete: only the PATH transits the PTY (env spec §5).
        { pane_id: paneId, text: ` . ${drop}; rm -f ${drop}`, keys: ["Enter"] },
        10_000,
      );
      await new Promise((r) => setTimeout(r, deps.envSettleMs ?? 300));
    } catch (e) {
      rmSync(drop, { force: true });
      const err = e instanceof BrokerError ? e : new BrokerError("upstream_error", String(e));
      throw new BrokerError(err.code, `env injection failed: ${err.message}`, {
        ...err.details,
        workspace_id: workspaceId,
        pane_id: paneId,
      });
    }
  }

  const name = typeof p.name === "string" ? p.name : kind;
  const timeoutMs = typeof p.timeout_ms === "number" ? p.timeout_ms : undefined;
  // agent_pane_busy on a fresh pane means the shell hasn't reached its
  // prompt yet (slow login zsh) — herdr's refusal is the only verified
  // readiness signal, so retry the SAME pane instead of failing out to a
  // client whose mode-B retry would leak a new workspace per attempt.
  const busyRetries = deps.paneBusyRetries ?? 4;
  const busyDelayMs = deps.paneBusyDelayMs ?? 1000;
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
      // The workspace exists — hand its id back so the client can retry into
      // it with mode B instead of leaking it (spec §2.1).
      throw new BrokerError(err.code, err.message, { ...err.details, workspace_id: workspaceId, pane_id: paneId });
    }
  }

  const raw = (await deps.local.request(session, "agent.list", {}, 5000).catch(() => ({}))) as {
    agents?: Array<Record<string, unknown>>;
  };
  const entry = raw.agents?.find((a) => a.pane_id === paneId);
  return { workspace_id: workspaceId, pane_id: paneId, agent: name, status: foldStatus(entry?.agent_status) };
}

/** Resolves the agent occupying a pane (or throws) — shared by the
 * pane-targeted TUI drivers below. */
async function agentInPane(
  deps: OpsDeps,
  session: string,
  pane: string,
): Promise<{ kind: string; entry: Record<string, unknown> }> {
  const raw = (await deps.local.request(session, "agent.list", {}, 10_000)) as {
    agents?: Array<Record<string, unknown>>;
  };
  const entry = raw.agents?.find((a) => a.pane_id === pane);
  if (!entry) throw new BrokerError("bad_request", `no agent in pane '${pane}'`);
  const kind = typeof entry.agent === "string" && entry.agent ? entry.agent : undefined;
  if (!kind) throw new BrokerError("upstream_error", `agent in pane '${pane}' reports no kind`);
  return { kind, entry };
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
  const text =
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
  mkdirSync(dir, { recursive: true });
  // A repo that commits .herdr/answers as a symlink pointing outside the
  // workspace must not let us readFileSync/rmSync through it (spec §2.5
  // step 5) — resolve both sides through symlinks before comparing.
  const realDir = realpathSync(dir);
  const realCwd = realpathSync(cwd);
  if (realDir !== realCwd && !realDir.startsWith(realCwd + sep)) {
    throw new BrokerError("unknown_workspace", "workspace answers dir escapes the workspace");
  }
  const file = join(dir, `${id}.json`);
  const text =
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
    const status = deps.registry.get("runtime")?.sessions[session]?.agents.find((a) => a.id === pane)?.status;
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
      throw new BrokerError(
        "agent_unresponsive",
        `agent in pane '${pane}' never started working within ${startGraceMs}ms — it may be dead or stuck`,
        { pane_id: pane },
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
