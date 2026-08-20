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
  "Ask",
  "RPC",
  "Env Registry",
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
    method: "GET",
    pathTemplate: "/parent/{instance}/sessions/{session}/agents",
    auth: "bearer",
    fields: [{ key: "fresh", label: "fresh — re-query herdr", kind: "toggle" }],
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
      "Exactly one of cwd / workspace_id is required. Env-registry values scoped to the agent kind are exported " +
      "into the pane shell before agent.start, so the CLI starts authenticated. On agent_pane_busy (a cold pane " +
      "whose shell is still booting) the broker retries the same pane internally.",
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
    id: "ask",
    group: "Ask",
    title: "Ask (structured answer)",
    summary: "Prompt a TUI agent and get a JSON answer back through a file-drop handshake — never scraped off the terminal.",
    docs:
      "The broker appends write-your-answer-to-.herdr/answers/<id>.json instructions to the prompt, then polls the " +
      "file and the agent's status. Oversize answers are truncated at 768KB; unparseable ones return raw with parse_error.",
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
