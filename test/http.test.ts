import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { EnvRegistry } from "../src/env-registry.js";
import { Registry } from "../src/registry.js";
import { LocalHerdr } from "../src/local-attach.js";
import { TunnelHub } from "../src/tunnel.js";
import { ChildrenStore } from "../src/state.js";
import { loadConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http.js";
import { WorkspaceIndex } from "../src/state.js";
import type { OpsDeps } from "../src/workspace-ops.js";
import { FakeHerdr } from "./fake-herdr.js";
import { scratchRepo, tmpDir } from "./util.js";

async function setup() {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  fake.agents = [{ pane_id: "w1:p1", name: "claude", agent_status: "working" }];
  await fake.listen();
  const registry = new Registry();
  const local = new LocalHerdr({
    registry,
    herdrVersion: "0.8.0-test",
    endpoints: [{ session: "default", socketPath: fake.socketPath }],
  });
  await local.start();
  const config = loadConfig(tmpDir());
  config.client_tokens = [{ name: "t", token: "tok" }];
  const children = new ChildrenStore(tmpDir());
  const ops: OpsDeps = {
    local,
    registry,
    index: new WorkspaceIndex(tmpDir()),
    env: new EnvRegistry({ stateDir: tmpDir() }),
    askPollMs: 25,
    askGraceMs: 150,
  };
  const server = createServer(
    createHttpHandler({
      registry,
      local,
      hub: new TunnelHub(),
      children,
      config,
      adminToken: "admin-tok",
      ops,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const authed = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: "Bearer tok", ...init.headers } });
  return { fake, registry, local, children, server, base, authed, ops };
}

async function teardown(t: { server: import("node:http").Server; local: LocalHerdr; fake: FakeHerdr }) {
  t.server.close();
  t.local.stop();
  await t.fake.close();
}

test("health needs no auth; /parent does", async () => {
  const t = await setup();
  const health = await (await fetch(t.base + "/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.name, "herdr-web-broker");
  assert.equal((await fetch(t.base + "/parent")).status, 401);
  await teardown(t);
});

test("GET grammar: rollup, instance, sessions, agents", async () => {
  const t = await setup();
  const { authed } = t;
  const roll = await (await authed("/parent")).json();
  assert.equal(roll.instances[0].instance, "runtime");
  assert.deepEqual(roll.instances[0].counts, { working: 1, blocked: 0, idle: 0 });

  const inst = await (await authed("/parent/runtime")).json();
  assert.equal(inst.herdr_version, "0.8.0-test");
  assert.deepEqual(inst.sessions, ["default"]);

  const sessions = await (await authed("/parent/runtime/sessions")).json();
  assert.deepEqual(sessions.sessions, [
    { name: "default", counts: { working: 1, blocked: 0, idle: 0 } },
  ]);

  const agents = await (await authed("/parent/runtime/sessions/default/agents")).json();
  assert.equal(agents.agents[0].id, "w1:p1");
  assert.equal((await authed("/parent/ghost")).status, 404);
  assert.equal((await authed("/parent/runtime/sessions/ghost/agents")).status, 404);
  await teardown(t);
});

test("rpc passthrough returns herdr results and relays herdr errors as 502", async () => {
  const t = await setup();
  const { authed } = t;
  const ok = await authed("/parent/runtime/sessions/default/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "agent.list", params: {} }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.agents.length, 1);

  const bad = await authed("/parent/runtime/sessions/default/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "no.such.method" }),
  });
  assert.equal(bad.status, 502);
  assert.equal((await bad.json()).code, "not_found");
  await teardown(t);
});

test("fresh=1 forwards agent.list and refreshes the registry", async () => {
  const t = await setup();
  const { fake, registry, authed } = t;
  fake.agents = [{ pane_id: "w1:p1", name: "claude", agent_status: "blocked" }];
  const res = await (await authed("/parent/runtime/sessions/default/agents?fresh=1")).json();
  assert.equal(res.agents[0].status, "blocked");
  assert.deepEqual(registry.counts("runtime"), { working: 0, blocked: 1, idle: 0 });
  await teardown(t);
});

test("auth is checked before route existence", async () => {
  const t = await setup();
  const { base, authed } = t;
  assert.equal((await fetch(base + "/nonsense")).status, 401);
  assert.equal((await authed("/nonsense")).status, 404);
  await teardown(t);
});

test("oversized body destroys the socket instead of desyncing keep-alive", async () => {
  const t = await setup();
  const { base, authed } = t;
  const oversized = JSON.stringify({
    method: "agent.list",
    params: { blob: "x".repeat(1_500_000) },
  });
  try {
    const res = await authed("/parent/runtime/sessions/default/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 400);
  } catch {
    // Acceptable: the client may see the reset socket as a rejected fetch
    // rather than a clean 400 — either way the daemon must survive it.
  }
  const health = await fetch(base + "/health", { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  await teardown(t);
});

test("admin: token-gated child minting and revocation", async () => {
  const t = await setup();
  const { base, children } = t;
  assert.equal((await fetch(base + "/admin/status")).status, 401);
  assert.equal(
    (await fetch(base + "/admin/status", { headers: { "x-admin-token": "wrong" } })).status,
    401,
  );
  const minted = await (
    await fetch(base + "/admin/children", {
      method: "POST",
      headers: { "x-admin-token": "admin-tok", "content-type": "application/json" },
      body: JSON.stringify({ name: "laptop" }),
    })
  ).json();
  assert.equal(minted.name, "laptop");
  assert.ok(minted.secret.length >= 40);
  assert.ok(children.get("laptop"));
  const revoked = await fetch(base + "/admin/children/laptop", {
    method: "DELETE",
    headers: { "x-admin-token": "admin-tok" },
  });
  assert.equal(revoked.status, 200);
  assert.equal(children.get("laptop"), undefined);
  await teardown(t);
});

test("broker.* virtual methods are reachable through the raw rpc passthrough", async () => {
  const t = await setup();
  const res = await t.authed("/parent/runtime/sessions/default/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "broker.workspace.list" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { workspaces: { workspace_id: string; cwd: null }[] } };
  assert.deepEqual(body.result.workspaces.map((w) => [w.workspace_id, w.cwd]), [["w1", null]]);
  // the virtual method never reached herdr's socket as itself
  assert.equal(t.fake.received.some((r) => r.method === "broker.workspace.list"), false);
  await teardown(t);
});

async function spawnDemo(t: Awaited<ReturnType<typeof setup>>, cwd: string) {
  t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
  t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));
  const res = await t.authed("/parent/runtime/sessions/default/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "copilot", cwd, label: "demo" }),
  });
  return res;
}

test("POST .../agents spawns and answers 201; bad bodies answer 400", async () => {
  const t = await setup();
  const cwd = scratchRepo();
  const res = await spawnDemo(t, cwd);
  assert.equal(res.status, 201);
  const body = (await res.json()) as { workspace_id: string; pane_id: string; agent: string };
  assert.equal(body.workspace_id, "w2");
  assert.equal(body.pane_id, "w2:p1");
  const bad = await t.authed("/parent/runtime/sessions/default/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "copilot" }),
  });
  assert.equal(bad.status, 400);
  await teardown(t);
});

test("POST .../agents with an absurd timeout_ms is clamped instead of overflowing setTimeout (spec route timeout clamp)", async () => {
  const t = await setup();
  const cwd = scratchRepo();
  t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
  t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));
  const res = await t.authed("/parent/runtime/sessions/default/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "copilot", cwd, timeout_ms: 1e15 }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { workspace_id: string; pane_id: string };
  assert.equal(body.workspace_id, "w2");
  assert.equal(body.pane_id, "w2:p1");
  await teardown(t);
});

test("GET .../workspaces shows the team roster and discovered repos after a spawn", async () => {
  const t = await setup();
  const cwd = scratchRepo();
  await spawnDemo(t, cwd);
  const res = await t.authed("/parent/runtime/sessions/default/workspaces");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    workspaces: { workspace_id: string; cwd: string | null; repos: { path: string }[] }[];
  };
  const w2 = body.workspaces.find((w) => w.workspace_id === "w2")!;
  assert.equal(w2.cwd, cwd);
  assert.deepEqual(w2.repos.map((r) => r.path), ["."]);
  await teardown(t);
});

test("GET tree and diff routes serve the workspace-root repo via the '-' token", async () => {
  const t = await setup();
  const cwd = scratchRepo();
  await spawnDemo(t, cwd);
  writeFileSync(join(cwd, "a.txt"), "two\n");

  const tree = await t.authed("/parent/runtime/sessions/default/workspaces/w2/repos/-/tree");
  assert.equal(tree.status, 200);
  const treeBody = (await tree.json()) as { tree: { children: { name: string }[] } };
  assert.deepEqual(treeBody.tree.children.map((c) => c.name), ["a.txt"]);

  const diff = await t.authed("/parent/runtime/sessions/default/workspaces/w2/repos/-/git/diff");
  assert.equal(diff.status, 200);
  const diffBody = (await diff.json()) as { branch: string; diff: string };
  assert.equal(diffBody.branch, "main");
  assert.match(diffBody.diff, /\+two/);

  assert.equal((await t.authed("/parent/runtime/sessions/default/workspaces/w2/repos/ghost/tree")).status, 404);
  assert.equal((await t.authed("/parent/runtime/sessions/default/workspaces/w9/repos/-/tree")).status, 404);
  assert.equal(
    (await t.authed("/parent/runtime/sessions/default/workspaces/w2/repos/-/git/diff?base=-rf")).status,
    400,
  );
  await teardown(t);
});

test("POST .../agents/{pane}/ask returns the parsed answer", async () => {
  const t = await setup();
  const cwd = scratchRepo();
  await spawnDemo(t, cwd);
  t.fake.agents.push({ pane_id: "w2:p1", name: "copilot", agent_status: "idle" });
  t.fake.handlers.set("agent.prompt", (p) => {
    const m = /\.herdr\/answers\/([a-f0-9]{16})\.json/.exec(String((p as { text: string }).text))!;
    writeFileSync(join(cwd, ".herdr", "answers", `${m[1]}.json`), '{"files_changed":1}');
    return { type: "prompted" };
  });
  const res = await t.authed("/parent/runtime/sessions/default/agents/w2%3Ap1/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "what changed?", timeout_ms: 5000 }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { answer: unknown }).answer, { files_changed: 1 });
  await teardown(t);
});

test("env routes: store, list (redacted, with source), delete; value absent everywhere", async () => {
  const t = await setup();
  try {
    const post = await t.authed("/parent/runtime/env", {
      method: "POST",
      body: JSON.stringify({ name: "COPILOT_GITHUB_TOKEN", value: "super-sekret", kind: "copilot" }),
    });
    assert.equal(post.status, 200);
    const stored = await post.json();
    assert.deepEqual(stored, { status: "stored", name: "COPILOT_GITHUB_TOKEN", scope: { kind: "copilot" } });

    const list = await t.authed("/parent/runtime/env");
    const body = await list.text();
    assert.ok(!body.includes("super-sekret"), "value must never appear in responses");
    const vars = JSON.parse(body).vars as { name: string; source: string }[];
    assert.deepEqual(vars.map((v) => [v.name, v.source]), [["COPILOT_GITHUB_TOKEN", "manual"]]);

    const del = await t.authed("/parent/runtime/env/COPILOT_GITHUB_TOKEN?kind=copilot", { method: "DELETE" });
    assert.equal(del.status, 200);
    const delAgain = await t.authed("/parent/runtime/env/COPILOT_GITHUB_TOKEN?kind=copilot", { method: "DELETE" });
    assert.equal(delAgain.status, 404);
  } finally {
    await teardown(t);
  }
});

test("env routes: bad name 400, unauthenticated 401, disabled 403", async () => {
  const t = await setup();
  try {
    const bad = await t.authed("/parent/runtime/env", {
      method: "POST",
      body: JSON.stringify({ name: "not-valid", value: "v" }),
    });
    assert.equal(bad.status, 400);
    const anon = await fetch(t.base + "/parent/runtime/env");
    assert.equal(anon.status, 401);
    (t.ops as { env: EnvRegistry }).env = new EnvRegistry({ stateDir: tmpDir(), enabled: false });
    const off = await t.authed("/parent/runtime/env");
    assert.equal(off.status, 403);
  } finally {
    await teardown(t);
  }
});
