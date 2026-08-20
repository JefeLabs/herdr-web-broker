import type { EndpointRequest } from "./client";

/** One entry per broker route. The console renders each entry as an
 * interactive card and the spec page renders the same entries as reference
 * docs — a single catalog so demo and docs cannot drift. */

export type FieldKind = "text" | "number" | "json" | "toggle" | "select";

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  placeholder?: string;
  options?: string[];
  help?: string;
  /** console-only control (e.g. a mode selector) — never part of the wire request */
  uiOnly?: boolean;
}

export interface Ctx {
  instance: string;
  session: string;
}

export interface EndpointSpec {
  id: string;
  group: string;
  title: string;
  summary: string;
  docs?: string;
  method: "GET" | "POST" | "DELETE";
  pathTemplate: string;
  auth: "bearer" | "admin" | "none";
  fields: FieldSpec[];
  /** JSON schema of the success response — surfaces in the OpenAPI doc for codegen */
  response?: Record<string, unknown>;
  build(values: Record<string, string>, ctx: Ctx): EndpointRequest;
}

const enc = encodeURIComponent;
const sess = (ctx: Ctx) => `/parent/${enc(ctx.instance)}/sessions/${enc(ctx.session)}`;

function need(values: Record<string, string>, key: string): string {
  const v = values[key]?.trim();
  if (!v) throw new Error(`'${key}' is required`);
  return v;
}

function parseJson(text: string, key: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`'${key}' is not valid JSON`);
  }
}

export const GROUPS = [
  "Health",
  "Instances",
  "Sessions & Agents",
  "Spawn",
  "Workspaces & Repos",
  "Git",
  "Context",
  "Ask",
  "Slash",
  "Spec Bundles",
  "RPC",
  "Env Registry",
  "Models",
  "Admin",
] as const;

export const CATALOG: EndpointSpec[] = [
  {
    id: "health",
    group: "Health",
    title: "Health",
    summary: "Liveness probe — name, version, pid. The only unauthenticated route.",
    method: "GET",
    pathTemplate: "/health",
    auth: "none",
    fields: [],
    build: () => ({ method: "GET", path: "/health", auth: "none" }),
  },
  {
    id: "instances",
    group: "Instances",
    title: "List instances",
    summary: "Every enrolled instance with its live status rollup. 'runtime' is this machine; anything else is a paired child.",
    method: "GET",
    pathTemplate: "/parent",
    auth: "bearer",
    fields: [],
    build: () => ({ method: "GET", path: "/parent", auth: "bearer" }),
  },
  {
    id: "instance",
    group: "Instances",
    title: "Instance detail",
    summary: "One instance: online flag, platform, herdr version, agent counts, session names.",
    method: "GET",
    pathTemplate: "/parent/{instance}",
    auth: "bearer",
    fields: [],
    build: (_v, ctx) => ({ method: "GET", path: `/parent/${enc(ctx.instance)}`, auth: "bearer" }),
  },
  {
    id: "auth-identify",
    group: "Instances",
    title: "Identify (who's using this)",
    summary: "Opt-in identity for the presented token — name/email show up in /parent's in_use_by so others can see the instance is occupied.",
    docs: "Presence is in-memory and expires after ~10 minutes of silence; every authed request refreshes it. 'auth' is a reserved instance name.",
    method: "POST",
    pathTemplate: "/parent/auth",
    auth: "bearer",
    fields: [
      { key: "name", label: "your name", kind: "text", placeholder: "Kathia" },
      { key: "email", label: "your email", kind: "text", placeholder: "you@example.com" },
    ],
    response: {
      type: "object",
      properties: {
        token: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        since: { type: "string" },
        last_seen: { type: "string" },
      },
      required: ["token", "since", "last_seen"],
    },
    build: (v) => {
      const body: Record<string, unknown> = {};
      if (v.name?.trim()) body.name = v.name.trim();
      if (v.email?.trim()) body.email = v.email.trim();
      return { method: "POST", path: "/parent/auth", auth: "bearer", body };
    },
  },
  {
    id: "sessions",
    group: "Sessions & Agents",
    title: "List sessions",
    summary: "herdr sessions on the instance, each with working/blocked/idle agent counts.",
    method: "GET",
    pathTemplate: "/parent/{instance}/sessions",
    auth: "bearer",
    fields: [],
    build: (_v, ctx) => ({ method: "GET", path: `/parent/${enc(ctx.instance)}/sessions`, auth: "bearer" }),
  },
  {
    id: "agents",
    group: "Sessions & Agents",
    title: "List agents",
    summary: "Agents in the session with pane ids and folded status. fresh=1 re-queries herdr instead of serving the cached snapshot.",
    docs:
      "status folds herdr's five states to working/blocked/idle for counts; raw_status carries the unfolded " +
      "truth (unknown/done fold to idle, so a dead-but-listed agent is only visible there) and fresh=1 also " +
      "returns interactive_ready/launch_pending.",
    method: "GET",
    pathTemplate: "/parent/{instance}/sessions/{session}/agents",
    auth: "bearer",
    fields: [{ key: "fresh", label: "fresh — re-query herdr", kind: "toggle" }],
    response: {
      type: "object",
      properties: {
        instance: { type: "string" },
        session: { type: "string" },
        online: { type: "boolean" },
        as_of: { type: "string" },
        agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              status: { type: "string", enum: ["working", "blocked", "idle"] },
              raw_status: { type: "string" },
              interactive_ready: { type: "boolean" },
              launch_pending: { type: "boolean" },
            },
            required: ["id", "title", "status"],
          },
        },
      },
      required: ["instance", "session", "agents"],
    },
    build: (v, ctx) => ({
      method: "GET",
      path: `${sess(ctx)}/agents`,
      auth: "bearer",
      ...(v.fresh === "1" ? { query: { fresh: "1" } } : {}),
    }),
  },
  {
    id: "spawn",
    group: "Spawn",
    title: "Spawn agent",
    summary: "Create a workspace pane and start a coding agent in it. Mode A: a new working set from cwd. Mode B: grow an existing workspace's team.",
    docs:
      "Exactly one of cwd / workspace_id is required. NOTE: workspace_id grows the team by creating a NEW " +
      "workspace sharing that cwd (herdr 0.8.0 has no verified pane-create) — it does not add a pane to the " +
      "existing workspace, and unused workspaces are not auto-reaped yet. Env-registry values scoped to the " +
      "agent kind are exported into the pane shell before agent.start, so the CLI starts authenticated. On " +
      "agent_pane_busy (a cold pane whose shell is still booting) the broker retries the same pane internally. " +
      "Response: agent is a STRING (the agent's name); status is top-level.",
    response: {
      type: "object",
      properties: {
        workspace_id: { type: "string" },
        pane_id: { type: "string" },
        agent: { type: "string", description: "the agent's name — a string, not an object" },
        status: { type: "string", enum: ["working", "blocked", "idle"] },
      },
      required: ["workspace_id", "pane_id", "agent", "status"],
    },
    method: "POST",
    pathTemplate: "/parent/{instance}/sessions/{session}/agents",
    auth: "bearer",
    fields: [
      { key: "kind", label: "kind", kind: "text", required: true, placeholder: "copilot" },
      { key: "target_mode", label: "target", kind: "select", options: ["cwd", "workspace_id"], uiOnly: true },
      { key: "cwd", label: "cwd (mode A)", kind: "text", placeholder: "/work" },
      { key: "workspace_id", label: "workspace_id (mode B)", kind: "text", placeholder: "w1" },
      { key: "label", label: "label", kind: "text", placeholder: "backend team" },
      { key: "name", label: "name", kind: "text", placeholder: "defaults to kind" },
      { key: "args", label: "args (JSON array)", kind: "json", placeholder: '["--model","gpt-5"]' },
      { key: "timeout_ms", label: "timeout_ms", kind: "number", placeholder: "30000" },
    ],
    build: (v, ctx) => {
      const kind = need(v, "kind");
      const body: Record<string, unknown> = { kind };
      if ((v.target_mode ?? "cwd") === "cwd") body.cwd = need(v, "cwd");
      else body.workspace_id = need(v, "workspace_id");
      if (v.label?.trim()) body.label = v.label.trim();
      if (v.name?.trim()) body.name = v.name.trim();
      if (v.args?.trim()) body.args = parseJson(v.args, "args");
      if (v.timeout_ms?.trim()) body.timeout_ms = Number(v.timeout_ms);
      return { method: "POST", path: `${sess(ctx)}/agents`, auth: "bearer", body };
    },
  },
  {
    id: "workspaces",
    group: "Workspaces & Repos",
    title: "List workspaces",
    summary: "Working sets: team roster (agents + status) and discovered git repos per workspace.",
    method: "GET",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces",
    auth: "bearer",
    fields: [],
    build: (_v, ctx) => ({ method: "GET", path: `${sess(ctx)}/workspaces`, auth: "bearer" }),
  },
  {
    id: "tree",
    group: "Workspaces & Repos",
    title: "Repo file tree",
    summary: "git's own file list (tracked + untracked-but-not-ignored) folded into a tree — .git and node_modules never appear.",
    docs: "repo is the discovered repo's path within the workspace; '-' means the workspace root itself is the repo.",
    method: "GET",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces/{workspace_id}/repos/{repo}/tree",
    auth: "bearer",
    fields: [
      { key: "workspace_id", label: "workspace_id", kind: "text", required: true, placeholder: "w1" },
      { key: "repo", label: "repo", kind: "text", required: true, placeholder: "-" },
    ],
    build: (v, ctx) => ({
      method: "GET",
      path: `${sess(ctx)}/workspaces/${enc(need(v, "workspace_id"))}/repos/${enc(need(v, "repo"))}/tree`,
      auth: "bearer",
    }),
  },
  {
    id: "diff",
    group: "Workspaces & Repos",
    title: "Repo git diff",
    summary: "Branch, porcelain status, and unified diff — optionally against a base ref.",
    method: "GET",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces/{workspace_id}/repos/{repo}/git/diff",
    auth: "bearer",
    fields: [
      { key: "workspace_id", label: "workspace_id", kind: "text", required: true, placeholder: "w1" },
      { key: "repo", label: "repo", kind: "text", required: true, placeholder: "-" },
      { key: "base", label: "base ref", kind: "text", placeholder: "origin/main" },
    ],
    build: (v, ctx) => ({
      method: "GET",
      path: `${sess(ctx)}/workspaces/${enc(need(v, "workspace_id"))}/repos/${enc(need(v, "repo"))}/git/diff`,
      auth: "bearer",
      ...(v.base?.trim() ? { query: { base: v.base.trim() } } : {}),
    }),
  },
  {
    id: "repo-file",
    group: "Workspaces & Repos",
    title: "Repo file contents",
    summary: "Raw file contents by path — the piece tree/diff can't serve, so IDE-like UIs can open unchanged files too.",
    docs: "Size-capped at 768KB with the same containment guards as the rest of the API; .git internals are refused; binary files return {binary: true} without content.",
    method: "GET",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces/{workspace_id}/repos/{repo}/file",
    auth: "bearer",
    fields: [
      { key: "workspace_id", label: "workspace_id", kind: "text", required: true, placeholder: "w1" },
      { key: "repo", label: "repo", kind: "text", required: true, placeholder: "-" },
      { key: "path", label: "path", kind: "text", required: true, placeholder: "src/index.ts" },
    ],
    response: {
      type: "object",
      properties: {
        workspace_id: { type: "string" },
        repo: { type: "string" },
        path: { type: "string" },
        size: { type: "number" },
        content: { type: "string" },
        truncated: { type: "boolean" },
        binary: { type: "boolean" },
      },
      required: ["workspace_id", "repo", "path", "size", "content"],
    },
    build: (v, ctx) => ({
      method: "GET",
      path: `${sess(ctx)}/workspaces/${enc(need(v, "workspace_id"))}/repos/${enc(need(v, "repo"))}/file`,
      auth: "bearer",
      query: { path: need(v, "path") },
    }),
  },
  {
    id: "git-commit",
    group: "Git",
    title: "Commit",
    summary: "Stage everything and commit — the 'keep it' step of the vibe-coding loop. A clean tree answers {committed:false, clean:true} instead of erroring.",
    docs:
      "add_all:false commits only what's already staged. Identity: body author wins, else repo/global config, " +
      "else a herdr-web-broker fallback so commits never fail on missing identity.",
    method: "POST",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces/{workspace_id}/repos/{repo}/git/commit",
    auth: "bearer",
    fields: [
      { key: "workspace_id", label: "workspace_id", kind: "text", required: true, placeholder: "w1" },
      { key: "repo", label: "repo", kind: "text", required: true, placeholder: "-" },
      { key: "message", label: "message", kind: "text", required: true, placeholder: "vibe: agent work" },
    ],
    response: {
      type: "object",
      properties: {
        committed: { type: "boolean" },
        clean: { type: "boolean" },
        commit: { type: "string" },
        branch: { type: "string" },
        subject: { type: "string" },
      },
      required: ["committed"],
    },
    build: (v, ctx) => ({
      method: "POST",
      path: `${sess(ctx)}/workspaces/${enc(need(v, "workspace_id"))}/repos/${enc(need(v, "repo"))}/git/commit`,
      auth: "bearer",
      body: { message: need(v, "message") },
    }),
  },
  {
    id: "git-log",
    group: "Git",
    title: "Log",
    summary: "Recent commits, newest first — {sha, subject, author, when}.",
    method: "GET",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces/{workspace_id}/repos/{repo}/git/log",
    auth: "bearer",
    fields: [
      { key: "workspace_id", label: "workspace_id", kind: "text", required: true, placeholder: "w1" },
      { key: "repo", label: "repo", kind: "text", required: true, placeholder: "-" },
      { key: "limit", label: "limit", kind: "number", placeholder: "20" },
    ],
    build: (v, ctx) => ({
      method: "GET",
      path: `${sess(ctx)}/workspaces/${enc(need(v, "workspace_id"))}/repos/${enc(need(v, "repo"))}/git/log`,
      auth: "bearer",
      ...(v.limit?.trim() ? { query: { limit: v.limit.trim() } } : {}),
    }),
  },
  {
    id: "git-push",
    group: "Git",
    title: "Push",
    summary: "Push the branch (defaults: origin, current branch). Credential and network failures surface git's own stderr as git_error.",
    method: "POST",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces/{workspace_id}/repos/{repo}/git/push",
    auth: "bearer",
    fields: [
      { key: "workspace_id", label: "workspace_id", kind: "text", required: true, placeholder: "w1" },
      { key: "repo", label: "repo", kind: "text", required: true, placeholder: "-" },
      { key: "remote", label: "remote", kind: "text", placeholder: "origin" },
      { key: "branch", label: "branch", kind: "text", placeholder: "current branch" },
    ],
    build: (v, ctx) => {
      const body: Record<string, unknown> = {};
      if (v.remote?.trim()) body.remote = v.remote.trim();
      if (v.branch?.trim()) body.branch = v.branch.trim();
      return {
        method: "POST",
        path: `${sess(ctx)}/workspaces/${enc(need(v, "workspace_id"))}/repos/${enc(need(v, "repo"))}/git/push`,
        auth: "bearer",
        body,
      };
    },
  },
  {
    id: "git-checkout",
    group: "Git",
    title: "Checkout",
    summary: "Switch to a branch or ref; create:true makes the branch first.",
    method: "POST",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces/{workspace_id}/repos/{repo}/git/checkout",
    auth: "bearer",
    fields: [
      { key: "workspace_id", label: "workspace_id", kind: "text", required: true, placeholder: "w1" },
      { key: "repo", label: "repo", kind: "text", required: true, placeholder: "-" },
      { key: "ref", label: "ref", kind: "text", required: true, placeholder: "feat/vibe" },
      { key: "create", label: "create branch", kind: "toggle" },
    ],
    build: (v, ctx) => ({
      method: "POST",
      path: `${sess(ctx)}/workspaces/${enc(need(v, "workspace_id"))}/repos/${enc(need(v, "repo"))}/git/checkout`,
      auth: "bearer",
      body: { ref: need(v, "ref"), ...(v.create === "1" ? { create: true } : {}) },
    }),
  },
  {
    id: "context-list",
    group: "Context",
    title: "List attachments",
    summary: "Files the human uploaded for the agent (PDFs, images, notes) — stored in .herdr/context/, never part of the repos.",
    docs:
      "Active attachments are automatically listed in the text of every prompt/ask/spec sent to agents in the " +
      "workspace, so the agent knows to read them. Upload rides PUT .../context/{name} with a raw binary body " +
      "(8MB cap) — use the upload card above or the SDK's context scope.",
    method: "GET",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces/{workspace_id}/context",
    auth: "bearer",
    fields: [{ key: "workspace_id", label: "workspace_id", kind: "text", required: true, placeholder: "w1" }],
    build: (v, ctx) => ({
      method: "GET",
      path: `${sess(ctx)}/workspaces/${enc(need(v, "workspace_id"))}/context`,
      auth: "bearer",
    }),
  },
  {
    id: "context-set",
    group: "Context",
    title: "Toggle active",
    summary: "active:false keeps the file but drops it from future prompts; active:true re-attaches it.",
    method: "POST",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces/{workspace_id}/context/{name}",
    auth: "bearer",
    fields: [
      { key: "workspace_id", label: "workspace_id", kind: "text", required: true, placeholder: "w1" },
      { key: "name", label: "name", kind: "text", required: true, placeholder: "spec.pdf" },
      { key: "active", label: "active — rides prompts", kind: "toggle" },
    ],
    build: (v, ctx) => ({
      method: "POST",
      path: `${sess(ctx)}/workspaces/${enc(need(v, "workspace_id"))}/context/${enc(need(v, "name"))}`,
      auth: "bearer",
      body: { active: v.active === "1" },
    }),
  },
  {
    id: "context-delete",
    group: "Context",
    title: "Delete attachment",
    summary: "Remove the file from the workspace context store.",
    method: "DELETE",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces/{workspace_id}/context/{name}",
    auth: "bearer",
    fields: [
      { key: "workspace_id", label: "workspace_id", kind: "text", required: true, placeholder: "w1" },
      { key: "name", label: "name", kind: "text", required: true, placeholder: "spec.pdf" },
    ],
    build: (v, ctx) => ({
      method: "DELETE",
      path: `${sess(ctx)}/workspaces/${enc(need(v, "workspace_id"))}/context/${enc(need(v, "name"))}`,
      auth: "bearer",
    }),
  },
  {
    id: "ask",
    group: "Ask",
    title: "Ask (structured answer)",
    summary: "Prompt a TUI agent and get a JSON answer back through a file-drop handshake — never scraped off the terminal.",
    docs:
      "The broker appends write-your-answer-to-.herdr/answers/<id>.json instructions to the prompt (the file must " +
      'be {"answer": <payload>} — the broker unwraps the envelope, so the response shape is deterministic), then ' +
      "polls the file and the agent's status. One ask at a time per pane — a second concurrent ask answers 409 pane_busy; steering via prompt stays allowed mid-ask. An agent that never starts working fails fast as agent_unresponsive " +
      "instead of hanging the full budget. Oversize answers truncate at 768KB; unparseable ones return raw with parse_error.",
    response: {
      type: "object",
      properties: {
        answer: { description: "the agent's JSON payload, unwrapped from the envelope" },
        raw: { type: "string" },
        truncated: { type: "boolean" },
        parse_error: { type: "boolean" },
      },
      required: ["answer"],
    },
    method: "POST",
    pathTemplate: "/parent/{instance}/sessions/{session}/agents/{pane_id}/ask",
    auth: "bearer",
    fields: [
      { key: "pane_id", label: "pane_id", kind: "text", required: true, placeholder: "w1:p1" },
      { key: "prompt", label: "prompt", kind: "text", required: true, placeholder: "List the repo's top-level dirs as a JSON array" },
      { key: "timeout_ms", label: "timeout_ms", kind: "number", placeholder: "120000" },
    ],
    build: (v, ctx) => {
      const pane = need(v, "pane_id");
      const body: Record<string, unknown> = { prompt: need(v, "prompt") };
      if (v.timeout_ms?.trim()) body.timeout_ms = Number(v.timeout_ms);
      return { method: "POST", path: `${sess(ctx)}/agents/${enc(pane)}/ask`, auth: "bearer", body };
    },
  },
  {
    id: "prompt",
    group: "Ask",
    title: "Prompt (fire-and-forget steering)",
    summary: "Send a free-form prompt to the same agent with no reply contract — the sequential-conversation channel: spawn once, then keep prompting the pane.",
    docs:
      "The pane_id is the conversation handle — the agent CLI keeps its full context between prompts. Use ask " +
      "when you want a structured JSON reply; watch progress via WS status events or pane.read over rpc.",
    method: "POST",
    pathTemplate: "/parent/{instance}/sessions/{session}/agents/{pane_id}/prompt",
    auth: "bearer",
    fields: [
      { key: "pane_id", label: "pane_id", kind: "text", required: true, placeholder: "w1:p1" },
      { key: "text", label: "text", kind: "text", required: true, placeholder: "actually, use OAuth for the login flow" },
    ],
    response: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["prompted"] },
        pane_id: { type: "string" },
        kind: { type: "string" },
        agent: { type: "string" },
      },
      required: ["status", "pane_id", "kind", "agent"],
    },
    build: (v, ctx) => ({
      method: "POST",
      path: `${sess(ctx)}/agents/${enc(need(v, "pane_id"))}/prompt`,
      auth: "bearer",
      body: { text: need(v, "text") },
    }),
  },
  {
    id: "slash",
    group: "Slash",
    title: "Send slash command",
    summary: "Type any of the agent CLI's own slash commands into its pane — /clear, /instructions, /login, /help…",
    docs:
      "Freeform by design: the TUI is the validator, so an unknown command just shows the CLI's own error. args " +
      "must be a single line (multi-line would smuggle extra Enter-terminated input) — full prompts belong to " +
      "ask or agent.prompt. Same 'sent' semantics as the model switch.",
    method: "POST",
    pathTemplate: "/parent/{instance}/sessions/{session}/agents/{pane_id}/slash/{command}",
    auth: "bearer",
    fields: [
      { key: "pane_id", label: "pane_id", kind: "text", required: true, placeholder: "w1:p1" },
      { key: "command", label: "command (no leading /)", kind: "text", required: true, placeholder: "clear" },
      { key: "args", label: "args (single line)", kind: "text", placeholder: "optional arguments" },
    ],
    build: (v, ctx) => ({
      method: "POST",
      path: `${sess(ctx)}/agents/${enc(need(v, "pane_id"))}/slash/${enc(need(v, "command"))}`,
      auth: "bearer",
      body: v.args?.trim() ? { args: v.args.trim() } : {},
    }),
  },
  {
    id: "spec-drive",
    group: "Spec Bundles",
    title: "Create / drive spec bundle",
    summary: "Create a bundle (a directory of design files the agent maintains) and prompt the agent to draft into it — or continue an existing one.",
    docs:
      "A bundle lives at docs/superpowers/specs/<YYYY-MM-DD-name>/ with overview.md seeded as the entry point; " +
      "the agent adds files as the design needs them (api.md, data-model.md, diagrams). Pass 'file' to target " +
      "the page you're viewing — the agent focuses there and puts its '## Open questions' in that file. Answer " +
      "questions by driving again with the same bundle id.",
    method: "POST",
    pathTemplate: "/parent/{instance}/sessions/{session}/agents/{pane_id}/spec-bundles",
    auth: "bearer",
    fields: [
      { key: "pane_id", label: "pane_id", kind: "text", required: true, placeholder: "w1:p1" },
      { key: "name", label: "name (new bundle)", kind: "text", placeholder: "checkout-flow" },
      { key: "bundle", label: "bundle id (continue)", kind: "text", placeholder: "2026-08-20-checkout-flow" },
      { key: "prompt", label: "prompt", kind: "text", required: true, placeholder: "draft the checkout flow design" },
      { key: "file", label: "active file (focus)", kind: "text", placeholder: "api.md" },
    ],
    build: (v, ctx) => {
      const body: Record<string, unknown> = { prompt: need(v, "prompt") };
      if (v.bundle?.trim()) body.bundle = v.bundle.trim();
      else body.name = need(v, "name");
      if (v.file?.trim()) body.file = v.file.trim();
      return { method: "POST", path: `${sess(ctx)}/agents/${enc(need(v, "pane_id"))}/spec-bundles`, auth: "bearer", body };
    },
  },
  {
    id: "spec-plan",
    group: "Spec Bundles",
    title: "Request implementation plan",
    summary: "Ask the agent to distill the bundle's design files into plan.md inside the same bundle.",
    method: "POST",
    pathTemplate: "/parent/{instance}/sessions/{session}/agents/{pane_id}/spec-bundles/{bundle}/plan",
    auth: "bearer",
    fields: [
      { key: "pane_id", label: "pane_id", kind: "text", required: true, placeholder: "w1:p1" },
      { key: "bundle", label: "bundle id", kind: "text", required: true, placeholder: "2026-08-20-checkout-flow" },
      { key: "prompt", label: "extra guidance", kind: "text", placeholder: "sequence backend before UI" },
    ],
    build: (v, ctx) => ({
      method: "POST",
      path: `${sess(ctx)}/agents/${enc(need(v, "pane_id"))}/spec-bundles/${enc(need(v, "bundle"))}/plan`,
      auth: "bearer",
      body: v.prompt?.trim() ? { prompt: v.prompt.trim() } : {},
    }),
  },
  {
    id: "spec-list",
    group: "Spec Bundles",
    title: "List spec bundles",
    summary: "Bundles found in the workspace with their member files.",
    method: "GET",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces/{workspace_id}/spec-bundles",
    auth: "bearer",
    fields: [{ key: "workspace_id", label: "workspace_id", kind: "text", required: true, placeholder: "w1" }],
    build: (v, ctx) => ({
      method: "GET",
      path: `${sess(ctx)}/workspaces/${enc(need(v, "workspace_id"))}/spec-bundles`,
      auth: "bearer",
    }),
  },
  {
    id: "spec-get",
    group: "Spec Bundles",
    title: "Pull spec bundle (long-poll)",
    summary: "All member files with a combined version hash. Pass your last version + wait_ms to long-poll: the reply arrives the moment the agent saves — edits and new files alike.",
    docs:
      "Long-poll instead of push so child instances stream through the parent↔child tunnel unchanged. Loop " +
      "GET → render → GET with the returned version to follow the bundle live.",
    method: "GET",
    pathTemplate: "/parent/{instance}/sessions/{session}/workspaces/{workspace_id}/spec-bundles/{bundle}",
    auth: "bearer",
    fields: [
      { key: "workspace_id", label: "workspace_id", kind: "text", required: true, placeholder: "w1" },
      { key: "bundle", label: "bundle id", kind: "text", required: true, placeholder: "2026-08-20-checkout-flow" },
      { key: "version", label: "last seen version", kind: "text", placeholder: "sha256…" },
      { key: "wait_ms", label: "wait_ms (long-poll)", kind: "number", placeholder: "25000" },
    ],
    build: (v, ctx) => {
      const query: Record<string, string> = {};
      if (v.version?.trim()) query.version = v.version.trim();
      if (v.wait_ms?.trim()) query.wait_ms = v.wait_ms.trim();
      return {
        method: "GET",
        path: `${sess(ctx)}/workspaces/${enc(need(v, "workspace_id"))}/spec-bundles/${enc(need(v, "bundle"))}`,
        auth: "bearer",
        ...(Object.keys(query).length > 0 ? { query } : {}),
      };
    },
  },
  {
    id: "rpc",
    group: "RPC",
    title: "RPC passthrough",
    summary: "Any herdr socket method by name — agent.list, pane.read, workspace.create… gated by the remote deny-list.",
    docs: "broker.* virtual methods dispatch in the broker itself; everything else forwards to herdr's socket verbatim.",
    method: "POST",
    pathTemplate: "/parent/{instance}/sessions/{session}/rpc",
    auth: "bearer",
    fields: [
      { key: "method", label: "method", kind: "text", required: true, placeholder: "agent.list" },
      { key: "params", label: "params (JSON)", kind: "json", placeholder: "{}" },
      { key: "timeout_ms", label: "timeout_ms", kind: "number", placeholder: "10000" },
    ],
    build: (v, ctx) => {
      const body: Record<string, unknown> = {
        method: need(v, "method"),
        params: v.params?.trim() ? parseJson(v.params, "params") : {},
      };
      if (v.timeout_ms?.trim()) body.timeout_ms = Number(v.timeout_ms);
      return { method: "POST", path: `${sess(ctx)}/rpc`, auth: "bearer", body };
    },
  },
  {
    id: "env-set",
    group: "Env Registry",
    title: "Store env var",
    summary: "Write-only credential store for agent spawns — the value is exported into the pane shell at spawn, never readable back.",
    method: "POST",
    pathTemplate: "/parent/{instance}/env",
    auth: "bearer",
    fields: [
      { key: "name", label: "name", kind: "text", required: true, placeholder: "GH_TOKEN" },
      { key: "value", label: "value", kind: "text", required: true, placeholder: "ghp_…" },
      { key: "kind", label: "kind scope", kind: "text", placeholder: "copilot" },
      { key: "session", label: "session scope", kind: "text", placeholder: "default" },
    ],
    build: (v, ctx) => {
      const body: Record<string, unknown> = { name: need(v, "name"), value: need(v, "value") };
      if (v.kind?.trim()) body.kind = v.kind.trim();
      if (v.session?.trim()) body.session = v.session.trim();
      return { method: "POST", path: `/parent/${enc(ctx.instance)}/env`, auth: "bearer", body };
    },
  },
  {
    id: "env-list",
    group: "Env Registry",
    title: "List env vars",
    summary: "Stored names, scopes, and source (manual/hook) — values are never returned.",
    method: "GET",
    pathTemplate: "/parent/{instance}/env",
    auth: "bearer",
    fields: [],
    build: (_v, ctx) => ({ method: "GET", path: `/parent/${enc(ctx.instance)}/env`, auth: "bearer" }),
  },
  {
    id: "env-delete",
    group: "Env Registry",
    title: "Delete env var",
    summary: "Remove one entry; kind/session query params select the scoped variant.",
    method: "DELETE",
    pathTemplate: "/parent/{instance}/env/{name}",
    auth: "bearer",
    fields: [
      { key: "name", label: "name", kind: "text", required: true, placeholder: "GH_TOKEN" },
      { key: "kind", label: "kind scope", kind: "text" },
      { key: "session", label: "session scope", kind: "text" },
    ],
    build: (v, ctx) => {
      const query: Record<string, string> = {};
      if (v.kind?.trim()) query.kind = v.kind.trim();
      if (v.session?.trim()) query.session = v.session.trim();
      return {
        method: "DELETE",
        path: `/parent/${enc(ctx.instance)}/env/${enc(need(v, "name"))}`,
        auth: "bearer",
        ...(Object.keys(query).length > 0 ? { query } : {}),
      };
    },
  },
  {
    id: "models-list",
    group: "Models",
    title: "List models",
    summary: "Model catalog per CLI kind with attributes (context window, max output) — builtin defaults layered with config.toml overrides.",
    docs:
      "No CLI exposes a machine-readable model list, so this is a registry: entries report source builtin or " +
      "config. Extend or correct it with [[models.catalog]] rows in config.toml — no code change needed.",
    method: "GET",
    pathTemplate: "/parent/{instance}/models",
    auth: "bearer",
    fields: [{ key: "kind", label: "kind filter", kind: "text", placeholder: "copilot" }],
    build: (v, ctx) => ({
      method: "GET",
      path: `/parent/${enc(ctx.instance)}/models`,
      auth: "bearer",
      ...(v.kind?.trim() ? { query: { kind: v.kind.trim() } } : {}),
    }),
  },
  {
    id: "agent-model",
    group: "Models",
    title: "Switch agent model",
    summary: "Switch a running agent's model by typing its CLI's own model command (e.g. /model gpt-5) into the pane.",
    docs:
      "'sent' semantics: a TUI gives no machine ack, so pane.read via rpc if you want visual confirmation. " +
      "Unknown models 404 (extend [[models.catalog]]); kinds without a switch template answer " +
      "model_switch_unsupported (add [[models.switch]]).",
    method: "POST",
    pathTemplate: "/parent/{instance}/sessions/{session}/agents/{pane_id}/model",
    auth: "bearer",
    fields: [
      { key: "pane_id", label: "pane_id", kind: "text", required: true, placeholder: "w1:p1" },
      { key: "model", label: "model", kind: "text", required: true, placeholder: "gpt-5" },
    ],
    build: (v, ctx) => ({
      method: "POST",
      path: `${sess(ctx)}/agents/${enc(need(v, "pane_id"))}/model`,
      auth: "bearer",
      body: { model: need(v, "model") },
    }),
  },
  {
    id: "admin-status",
    group: "Admin",
    title: "Admin status",
    summary: "Listen address, instance rollup, enrolled child names. Loopback + x-admin-token only.",
    method: "GET",
    pathTemplate: "/admin/status",
    auth: "admin",
    fields: [],
    build: () => ({ method: "GET", path: "/admin/status", auth: "admin" }),
  },
  {
    id: "admin-child-add",
    group: "Admin",
    title: "Issue child secret",
    summary: "Mint a pairing secret for a new child instance — shown once, stored hashed.",
    method: "POST",
    pathTemplate: "/admin/children",
    auth: "admin",
    fields: [{ key: "name", label: "child name", kind: "text", required: true, placeholder: "laptop" }],
    build: (v) => ({ method: "POST", path: "/admin/children", auth: "admin", body: { name: need(v, "name") } }),
  },
  {
    id: "admin-child-revoke",
    group: "Admin",
    title: "Revoke child",
    summary: "Delete the child's secret and disconnect its tunnel.",
    method: "DELETE",
    pathTemplate: "/admin/children/{name}",
    auth: "admin",
    fields: [{ key: "name", label: "child name", kind: "text", required: true }],
    build: (v) => ({ method: "DELETE", path: `/admin/children/${enc(need(v, "name"))}`, auth: "admin" }),
  },
  {
    id: "admin-token-revoke",
    group: "Admin",
    title: "Revoke client token",
    summary: "Remove a [[client_tokens]] entry by name — immediate for new requests and WS upgrades, persisted to config.toml.",
    docs:
      "Auth is stateless bearer tokens, so this is the sign-out equivalent. Already-open WS sockets authed with " +
      "the revoked token stay connected until they close. Unknown names 404 (unknown_token).",
    method: "DELETE",
    pathTemplate: "/admin/tokens/{name}",
    auth: "admin",
    fields: [{ key: "name", label: "token name", kind: "text", required: true, placeholder: "demo" }],
    build: (v) => ({ method: "DELETE", path: `/admin/tokens/${enc(need(v, "name"))}`, auth: "admin" }),
  },
  {
    id: "admin-kick",
    group: "Admin",
    title: "Kick user",
    summary: "Full eviction of a token's user: revoke the token (immediate + persisted), terminate their live WS sockets, type /logout into matching agent panes, clear presence.",
    docs: "kinds defaults to [\"copilot\"]; logout_agents:false skips the agent logout. Logout is 'sent' semantics — pane.read confirms.",
    method: "POST",
    pathTemplate: "/admin/kick/{name}",
    auth: "admin",
    fields: [
      { key: "name", label: "token name", kind: "text", required: true, placeholder: "demo" },
      { key: "kinds", label: "agent kinds to log out (JSON array)", kind: "json", placeholder: '["copilot"]' },
      { key: "skip_logout", label: "skip agent logout", kind: "toggle" },
    ],
    response: {
      type: "object",
      properties: {
        kicked: { type: "string" },
        token_revoked: { type: "boolean" },
        sockets_closed: { type: "number" },
        logged_out_panes: { type: "array", items: { type: "string" } },
      },
      required: ["kicked", "token_revoked", "sockets_closed", "logged_out_panes"],
    },
    build: (v) => {
      const body: Record<string, unknown> = {};
      if (v.kinds?.trim()) body.kinds = parseJson(v.kinds, "kinds");
      if (v.skip_logout === "1") body.logout_agents = false;
      return { method: "POST", path: `/admin/kick/${enc(need(v, "name"))}`, auth: "admin", body };
    },
  },
  {
    id: "admin-mint-token",
    group: "Admin",
    title: "Mint client token (dev)",
    summary: "Generate a new bearer token by name — for dev environments. Off by default; [token_mint] enabled = true turns it on (this demo stack enables it).",
    docs:
      "The minted token authenticates immediately, persists to config.toml, and is revocable/kickable by name " +
      "like any other. Disabled brokers answer 403 mint_disabled — production parents should leave it off.",
    method: "POST",
    pathTemplate: "/admin/tokens",
    auth: "admin",
    fields: [{ key: "name", label: "token name", kind: "text", required: true, placeholder: "guest" }],
    response: {
      type: "object",
      properties: { name: { type: "string" }, token: { type: "string" } },
      required: ["name", "token"],
    },
    build: (v) => ({ method: "POST", path: "/admin/tokens", auth: "admin", body: { name: need(v, "name") } }),
  },
  {
    id: "admin-reload",
    group: "Admin",
    title: "Reload config",
    summary: "Re-read config.toml — tokens, policy, parent link — without restarting the daemon.",
    method: "POST",
    pathTemplate: "/admin/reload",
    auth: "admin",
    fields: [],
    build: () => ({ method: "POST", path: "/admin/reload", auth: "admin" }),
  },
];
