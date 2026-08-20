import { expect, test } from "vitest";
import { CATALOG, type EndpointSpec } from "./catalog";

const ctx = { instance: "runtime", session: "default" };

function spec(id: string): EndpointSpec {
  const s = CATALOG.find((e) => e.id === id);
  if (!s) throw new Error(`no catalog entry '${id}'`);
  return s;
}

test("every broker route in the README is present exactly once", () => {
  const ids = CATALOG.map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of [
    "health",
    "instances",
    "instance",
    "sessions",
    "agents",
    "spawn",
    "workspaces",
    "tree",
    "diff",
    "repo-file",
    "ask",
    "slash",
    "spec-drive",
    "spec-plan",
    "spec-list",
    "spec-get",
    "rpc",
    "env-set",
    "env-list",
    "env-delete",
    "models-list",
    "agent-model",
    "admin-status",
    "admin-child-add",
    "admin-child-revoke",
    "admin-token-revoke",
    "admin-reload",
  ]) {
    expect(ids).toContain(id);
  }
});

test("health needs no auth; admin routes need admin auth", () => {
  expect(spec("health").build({}, ctx).auth).toBe("none");
  expect(spec("admin-status").build({}, ctx).auth).toBe("admin");
});

test("instance detail encodes the context instance", () => {
  const req = spec("instance").build({}, { ...ctx, instance: "my box" });
  expect(req.path).toBe("/parent/my%20box");
});

test("agents: fresh toggle becomes ?fresh=1, absent otherwise", () => {
  expect(spec("agents").build({ fresh: "1" }, ctx).query).toEqual({ fresh: "1" });
  expect(spec("agents").build({}, ctx).query).toBeUndefined();
});

test("spawn: cwd mode builds the body; args parse as a JSON array", () => {
  const req = spec("spawn").build(
    { kind: "copilot", target_mode: "cwd", cwd: "/work", label: "demo", args: '["--model","gpt-5"]' },
    ctx,
  );
  expect(req.method).toBe("POST");
  expect(req.path).toBe("/parent/runtime/sessions/default/agents");
  expect(req.body).toEqual({ kind: "copilot", cwd: "/work", label: "demo", args: ["--model", "gpt-5"] });
});

test("spawn: workspace mode sends workspace_id and never cwd", () => {
  const req = spec("spawn").build({ kind: "claude", target_mode: "workspace_id", workspace_id: "w2" }, ctx);
  expect(req.body).toEqual({ kind: "claude", workspace_id: "w2" });
});

test("spawn: missing kind or missing target throws", () => {
  expect(() => spec("spawn").build({ target_mode: "cwd", cwd: "/w" }, ctx)).toThrow(/kind/);
  expect(() => spec("spawn").build({ kind: "copilot", target_mode: "cwd" }, ctx)).toThrow(/cwd/);
});

test("tree: the workspace-root repo '-' and slashed repo paths are both encoded path segments", () => {
  expect(spec("tree").build({ workspace_id: "w1", repo: "-" }, ctx).path).toBe(
    "/parent/runtime/sessions/default/workspaces/w1/repos/-/tree",
  );
  expect(spec("tree").build({ workspace_id: "w1", repo: "pkg/app" }, ctx).path).toContain("/repos/pkg%2Fapp/tree");
});

test("diff: base ref rides the query string only when given", () => {
  const req = spec("diff").build({ workspace_id: "w1", repo: "-", base: "origin/main" }, ctx);
  expect(req.path).toBe("/parent/runtime/sessions/default/workspaces/w1/repos/-/git/diff");
  expect(req.query).toEqual({ base: "origin/main" });
  expect(spec("diff").build({ workspace_id: "w1", repo: "-" }, ctx).query).toBeUndefined();
});

test("repo-file: path rides the query, repo and workspace are path segments", () => {
  const req = spec("repo-file").build({ workspace_id: "w1", repo: "pkg/app", path: "src/index.ts" }, ctx);
  expect(req.path).toBe("/parent/runtime/sessions/default/workspaces/w1/repos/pkg%2Fapp/file");
  expect(req.query).toEqual({ path: "src/index.ts" });
  expect(() => spec("repo-file").build({ workspace_id: "w1", repo: "-" }, ctx)).toThrow(/path/);
});

test("ask: pane id is encoded and prompt is required", () => {
  const req = spec("ask").build({ pane_id: "w1:p1", prompt: "list files", timeout_ms: "60000" }, ctx);
  expect(req.path).toBe("/parent/runtime/sessions/default/agents/w1%3Ap1/ask");
  expect(req.body).toEqual({ prompt: "list files", timeout_ms: 60000 });
  expect(() => spec("ask").build({ pane_id: "w1:p1" }, ctx)).toThrow(/prompt/);
});

test("slash: command joins the path, args ride the body only when set", () => {
  const req = spec("slash").build({ pane_id: "w1:p1", command: "instructions", args: "keep it short" }, ctx);
  expect(req.method).toBe("POST");
  expect(req.path).toBe("/parent/runtime/sessions/default/agents/w1%3Ap1/slash/instructions");
  expect(req.body).toEqual({ args: "keep it short" });
  expect(spec("slash").build({ pane_id: "w1:p1", command: "clear" }, ctx).body).toEqual({});
  expect(() => spec("slash").build({ pane_id: "w1:p1" }, ctx)).toThrow(/command/);
});

test("spec bundle specs: drive body, plan path, get long-poll query", () => {
  const drive = spec("spec-drive").build(
    { pane_id: "w1:p1", name: "checkout", prompt: "draft it", file: "api.md" },
    ctx,
  );
  expect(drive.path).toBe("/parent/runtime/sessions/default/agents/w1%3Ap1/spec-bundles");
  expect(drive.body).toEqual({ name: "checkout", prompt: "draft it", file: "api.md" });

  const plan = spec("spec-plan").build({ pane_id: "w1:p1", bundle: "2026-08-20-checkout" }, ctx);
  expect(plan.path).toBe("/parent/runtime/sessions/default/agents/w1%3Ap1/spec-bundles/2026-08-20-checkout/plan");

  const get = spec("spec-get").build(
    { workspace_id: "w1", bundle: "2026-08-20-checkout", version: "abc", wait_ms: "25000" },
    ctx,
  );
  expect(get.path).toBe("/parent/runtime/sessions/default/workspaces/w1/spec-bundles/2026-08-20-checkout");
  expect(get.query).toEqual({ version: "abc", wait_ms: "25000" });
  expect(spec("spec-get").build({ workspace_id: "w1", bundle: "b" }, ctx).query).toBeUndefined();

  expect(spec("spec-list").build({ workspace_id: "w1" }, ctx).path).toBe(
    "/parent/runtime/sessions/default/workspaces/w1/spec-bundles",
  );
});

test("rpc: params must be valid JSON", () => {
  const req = spec("rpc").build({ method: "agent.list", params: "{}" }, ctx);
  expect(req.body).toEqual({ method: "agent.list", params: {} });
  expect(() => spec("rpc").build({ method: "agent.list", params: "{oops" }, ctx)).toThrow(/JSON/);
});

test("env-delete: scope selectors become query params only when set", () => {
  const req = spec("env-delete").build({ name: "GH_TOKEN", kind: "copilot" }, ctx);
  expect(req.method).toBe("DELETE");
  expect(req.path).toBe("/parent/runtime/env/GH_TOKEN");
  expect(req.query).toEqual({ kind: "copilot" });
  expect(spec("env-delete").build({ name: "GH_TOKEN" }, ctx).query).toBeUndefined();
});

test("models-list: kind filter rides the query only when set", () => {
  expect(spec("models-list").build({}, ctx).path).toBe("/parent/runtime/models");
  expect(spec("models-list").build({}, ctx).query).toBeUndefined();
  expect(spec("models-list").build({ kind: "claude" }, ctx).query).toEqual({ kind: "claude" });
});

test("agent-model: pane is encoded into the path and model is required", () => {
  const req = spec("agent-model").build({ pane_id: "w1:p1", model: "opus" }, ctx);
  expect(req.method).toBe("POST");
  expect(req.path).toBe("/parent/runtime/sessions/default/agents/w1%3Ap1/model");
  expect(req.body).toEqual({ model: "opus" });
  expect(() => spec("agent-model").build({ pane_id: "w1:p1" }, ctx)).toThrow(/model/);
});

test("admin child revoke encodes the name into the path", () => {
  expect(spec("admin-child-revoke").build({ name: "old laptop" }, ctx).path).toBe("/admin/children/old%20laptop");
});

test("admin token revoke: DELETE with the name encoded into the path", () => {
  const req = spec("admin-token-revoke").build({ name: "old client" }, ctx);
  expect(req.method).toBe("DELETE");
  expect(req.path).toBe("/admin/tokens/old%20client");
  expect(req.auth).toBe("admin");
  expect(() => spec("admin-token-revoke").build({}, ctx)).toThrow(/name/);
});
