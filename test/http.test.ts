import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { EnvRegistry } from "../src/env-registry.js";
import { Presence } from "../src/presence.js";
import { ModelRegistry } from "../src/model-registry.js";
import { Registry } from "../src/registry.js";
import { LocalHerdr } from "../src/local-attach.js";
import { TunnelHub } from "../src/tunnel.js";
import { ChildrenStore } from "../src/state.js";
import { loadConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http.js";
import { WorkspaceIndex } from "../src/state.js";
import type { OpsDeps } from "../src/workspace-ops.js";
import { FakeHerdr } from "./fake-herdr.js";
import { scratchRepo, sh, tmpDir } from "./util.js";

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
    models: new ModelRegistry(),
    askPollMs: 25,
    askGraceMs: 150,
  };
  const persisted: string[] = [];
  const presence = new Presence();
  const kicked: string[] = [];
  const server = createServer(
    createHttpHandler({
      registry,
      local,
      hub: new TunnelHub(),
      children,
      config,
      adminToken: "admin-tok",
      ops,
      onTokensChanged: () => persisted.push("saved"),
      presence,
      onKickSockets: (name) => {
        kicked.push(name);
        return 2;
      },
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const authed = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: "Bearer tok", ...init.headers } });
  return { fake, registry, local, children, server, base, authed, ops, config, persisted, presence, kicked };
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

test("admin: token revocation takes effect immediately and persists via the callback", async () => {
  const t = await setup();
  try {
    // second token so revocation of one leaves the other working
    t.config.client_tokens.push({ name: "second", token: "tok2" });

    assert.equal((await t.authed("/parent")).status, 200, "primary token works before revocation");

    const gone = await fetch(t.base + "/admin/tokens/t", {
      method: "DELETE",
      headers: { "x-admin-token": "admin-tok" },
    });
    assert.equal(gone.status, 200);
    assert.deepEqual(await gone.json(), { revoked: "t", remaining: 1 });
    assert.equal(t.persisted.length, 1, "revocation persists through the onTokensChanged callback");

    assert.equal((await t.authed("/parent")).status, 401, "revoked token refused immediately");
    const other = await fetch(t.base + "/parent", { headers: { authorization: "Bearer tok2" } });
    assert.equal(other.status, 200, "remaining token still works");

    const unknown = await fetch(t.base + "/admin/tokens/ghost", {
      method: "DELETE",
      headers: { "x-admin-token": "admin-tok" },
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, "unknown_token");
  } finally {
    await teardown(t);
  }
});

test("model routes: instance catalog with kind filter; pane switch sends the CLI command", async () => {
  const t = await setup();
  try {
    t.fake.agents = [{ pane_id: "w1:p1", name: "claude", agent: "claude", agent_status: "idle" }];
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));

    const all = await t.authed("/parent/runtime/models");
    assert.equal(all.status, 200);
    const catalog = (await all.json()).models as { kind: string; id: string; context_window?: number }[];
    assert.ok(new Set(catalog.map((m) => m.kind)).size > 1, "unfiltered catalog spans kinds");

    const filtered = await t.authed("/parent/runtime/models?kind=claude");
    const claude = (await filtered.json()).models as { kind: string }[];
    assert.ok(claude.length > 0 && claude.every((m) => m.kind === "claude"));

    const sw = await t.authed("/parent/runtime/sessions/default/agents/w1%3Ap1/model", {
      method: "POST",
      body: JSON.stringify({ model: "opus" }),
    });
    assert.equal(sw.status, 200);
    assert.deepEqual(await sw.json(), {
      status: "sent",
      pane_id: "w1:p1",
      kind: "claude",
      model: "opus",
      command: "/model opus",
    });
    const sent = t.fake.received.find((r) => r.method === "pane.send_input");
    assert.deepEqual(sent?.params, { pane_id: "w1:p1", text: "/model opus", keys: ["Enter"] });

    const bad = await t.authed("/parent/runtime/sessions/default/agents/w1%3Ap1/model", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-99" }),
    });
    assert.equal(bad.status, 404);
    assert.equal((await bad.json()).code, "unknown_model");
  } finally {
    await teardown(t);
  }
});

test("slash route: POST .../slash/{command} types the command; args ride the body", async () => {
  const t = await setup();
  try {
    t.fake.agents = [{ pane_id: "w1:p1", name: "claude", agent: "claude", agent_status: "idle" }];
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    const res = await t.authed("/parent/runtime/sessions/default/agents/w1%3Ap1/slash/instructions", {
      method: "POST",
      body: JSON.stringify({ args: "keep answers short" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: "sent",
      pane_id: "w1:p1",
      kind: "claude",
      command: "/instructions keep answers short",
    });
    const sent = t.fake.received.find((r) => r.method === "pane.send_input");
    assert.deepEqual(sent?.params, { pane_id: "w1:p1", text: "/instructions keep answers short", keys: ["Enter"] });
  } finally {
    await teardown(t);
  }
});

test("pane screen route: GET serves the terminal text; version+wait_ms long-polls; source passes through", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("pane.read", () => ({ type: "pane_read", read: { text: "❯ building…" } }));

    const res = await t.authed("/parent/runtime/sessions/default/panes/w1%3Ap1/screen");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pane_id: string; source: string; text: string; version: string };
    assert.equal(body.pane_id, "w1:p1");
    assert.equal(body.source, "visible");
    assert.equal(body.text, "❯ building…");

    const idle = await t.authed(
      `/parent/runtime/sessions/default/panes/w1%3Ap1/screen?version=${body.version}&wait_ms=100`,
    );
    assert.equal(((await idle.json()) as { unchanged?: boolean }).unchanged, true);

    const recent = await t.authed("/parent/runtime/sessions/default/panes/w1%3Ap1/screen?source=recent");
    assert.equal(((await recent.json()) as { source: string }).source, "recent");
    const sent = t.fake.received.find((r) => r.method === "pane.read" && (r.params as { source: string }).source === "recent");
    assert.ok(sent, "recent source reached herdr");

    const bad = await t.authed("/parent/runtime/sessions/default/panes/w1%3Ap1/screen?source=history");
    assert.equal(bad.status, 400);
  } finally {
    await teardown(t);
  }
});

test("spec-bundle routes: drive creates and prompts; get/list/plan wire through", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.ops.index.set("default", "w1", { cwd });
    t.fake.agents = [{ pane_id: "w1:p1", name: "claude", agent: "claude", agent_status: "idle" }];
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));

    const drive = await t.authed("/parent/runtime/sessions/default/agents/w1%3Ap1/spec-bundles", {
      method: "POST",
      body: JSON.stringify({ name: "checkout", prompt: "draft it" }),
    });
    assert.equal(drive.status, 201);
    const made = (await drive.json()) as { bundle: string; dir: string; files: string[]; version: string };
    assert.deepEqual(made.files, ["overview.md"]);

    const got = await t.authed(`/parent/runtime/sessions/default/workspaces/w1/spec-bundles/${made.bundle}`);
    assert.equal(got.status, 200);
    const body = (await got.json()) as { version: string; files: Record<string, { content: string }> };
    assert.ok(body.files["overview.md"].content.includes("checkout"));

    const idle = await t.authed(
      `/parent/runtime/sessions/default/workspaces/w1/spec-bundles/${made.bundle}?version=${body.version}&wait_ms=150`,
    );
    assert.equal(((await idle.json()) as { unchanged?: boolean }).unchanged, true);

    const list = await t.authed("/parent/runtime/sessions/default/workspaces/w1/spec-bundles");
    assert.deepEqual(((await list.json()) as { bundles: { bundle: string }[] }).bundles.map((b) => b.bundle), [
      made.bundle,
    ]);

    const plan = await t.authed(
      `/parent/runtime/sessions/default/agents/w1%3Ap1/spec-bundles/${made.bundle}/plan`,
      { method: "POST", body: JSON.stringify({ prompt: "backend first" }) },
    );
    assert.equal(plan.status, 200);
    assert.equal(((await plan.json()) as { file: string }).file, "plan.md");
  } finally {
    await teardown(t);
  }
});

test("prompt route: POST .../agents/{pane}/prompt steers the agent fire-and-forget", async () => {
  const t = await setup();
  try {
    t.fake.agents = [{ pane_id: "w1:p1", name: "claude", agent: "claude", agent_status: "working" }];
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    const res = await t.authed("/parent/runtime/sessions/default/agents/w1%3Ap1/prompt", {
      method: "POST",
      body: JSON.stringify({ text: "focus on the tests first" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "prompted", pane_id: "w1:p1", kind: "claude", agent: "claude" });
    const sent = t.fake.received.find((r) => r.method === "agent.prompt");
    assert.deepEqual(sent?.params, { target: "claude", text: "focus on the tests first" });
  } finally {
    await teardown(t);
  }
});

test("repo file route: reads content by path; traversal answers 400", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.ops.index.set("default", "w1", { cwd });
    const ok = await t.authed("/parent/runtime/sessions/default/workspaces/w1/repos/-/file?path=a.txt");
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { content: string }).content, "one\n");
    const bad = await t.authed("/parent/runtime/sessions/default/workspaces/w1/repos/-/file?path=..%2Fescape");
    assert.equal(bad.status, 400);
  } finally {
    await teardown(t);
  }
});

test("git routes: commit → log → checkout → push against a real repo with a bare remote", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    const bare = tmpDir();
    sh(bare, ["init", "-q", "--bare"]);
    sh(cwd, ["remote", "add", "origin", bare]);
    t.ops.index.set("default", "w1", { cwd });
    writeFileSync(join(cwd, "vibe.txt"), "made by an agent\n");

    const commit = await t.authed("/parent/runtime/sessions/default/workspaces/w1/repos/-/git/commit", {
      method: "POST",
      body: JSON.stringify({ message: "vibe: agent work" }),
    });
    assert.equal(commit.status, 200);
    const made = (await commit.json()) as { committed: boolean; commit: string; branch: string };
    assert.equal(made.committed, true);
    assert.equal(made.branch, "main");

    const log = await t.authed("/parent/runtime/sessions/default/workspaces/w1/repos/-/git/log?limit=5");
    const commits = ((await log.json()) as { commits: { subject: string }[] }).commits;
    assert.equal(commits[0].subject, "vibe: agent work");

    const co = await t.authed("/parent/runtime/sessions/default/workspaces/w1/repos/-/git/checkout", {
      method: "POST",
      body: JSON.stringify({ ref: "feat/vibe", create: true }),
    });
    assert.deepEqual(await co.json(), { workspace_id: "w1", repo: "-", branch: "feat/vibe" });

    const push = await t.authed("/parent/runtime/sessions/default/workspaces/w1/repos/-/git/push", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const pushed = (await push.json()) as { pushed: boolean; branch: string };
    assert.equal(pushed.pushed, true);
    assert.equal(pushed.branch, "feat/vibe");

    const bad = await t.authed("/parent/runtime/sessions/default/workspaces/w1/repos/-/git/commit", {
      method: "POST",
      body: JSON.stringify({ message: "   " }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await teardown(t);
  }
});

test("context routes: raw upload → list → binary download → toggle → delete", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.ops.index.set("default", "w1", { cwd });
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x01]); // %PDF + binary tail

    const up = await t.authed("/parent/runtime/sessions/default/workspaces/w1/context/spec.pdf", {
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      body: bytes,
    });
    assert.equal(up.status, 201);
    assert.equal(((await up.json()) as { active: boolean }).active, true);

    const list = await t.authed("/parent/runtime/sessions/default/workspaces/w1/context");
    const attachments = ((await list.json()) as { attachments: { name: string; content_type: string }[] }).attachments;
    assert.deepEqual([attachments[0].name, attachments[0].content_type], ["spec.pdf", "application/pdf"]);

    const dl = await t.authed("/parent/runtime/sessions/default/workspaces/w1/context/spec.pdf");
    assert.equal(dl.headers.get("content-type"), "application/pdf");
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes, "binary round-trips exactly");

    const toggled = await t.authed("/parent/runtime/sessions/default/workspaces/w1/context/spec.pdf", {
      method: "POST",
      body: JSON.stringify({ active: false }),
    });
    assert.equal(((await toggled.json()) as { active: boolean }).active, false);

    const gone = await t.authed("/parent/runtime/sessions/default/workspaces/w1/context/spec.pdf", {
      method: "DELETE",
    });
    assert.equal(gone.status, 200);
    assert.equal((await t.authed("/parent/runtime/sessions/default/workspaces/w1/context/spec.pdf")).status, 404);
  } finally {
    await teardown(t);
  }
});

test("presence: POST /parent/auth records identity; /parent shows in_use_by; kick evicts everything", async () => {
  const t = await setup();
  try {
    t.fake.agents = [{ pane_id: "w1:p1", name: "claude", agent: "claude", agent_status: "idle" }];
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));

    const id = await t.authed("/parent/auth", {
      method: "POST",
      body: JSON.stringify({ name: "Kathia", email: "kathia@example.com" }),
    });
    assert.equal(id.status, 200);
    const entry = (await id.json()) as { token: string; name: string; email: string };
    assert.deepEqual([entry.token, entry.name, entry.email], ["t", "Kathia", "kathia@example.com"]);

    const roll = (await (await t.authed("/parent")).json()) as { in_use_by: { token: string; name: string }[] };
    assert.deepEqual(roll.in_use_by.map((u) => [u.token, u.name]), [["t", "Kathia"]]);

    const badEmail = await t.authed("/parent/auth", { method: "POST", body: JSON.stringify({ email: "not-an-email" }) });
    assert.equal(badEmail.status, 400);

    const kick = await fetch(t.base + "/admin/kick/t", {
      method: "POST",
      headers: { "x-admin-token": "admin-tok", "content-type": "application/json" },
      body: JSON.stringify({ kinds: ["claude"] }),
    });
    assert.equal(kick.status, 200);
    const out = (await kick.json()) as {
      kicked: string;
      token_revoked: boolean;
      sockets_closed: number;
      logged_out_panes: string[];
    };
    assert.deepEqual(out, { kicked: "t", token_revoked: true, sockets_closed: 2, logged_out_panes: ["w1:p1"] });
    assert.deepEqual(t.kicked, ["t"]);
    const sent = t.fake.received.find((r) => r.method === "pane.send_input");
    assert.deepEqual(sent?.params, { pane_id: "w1:p1", text: "/logout", keys: ["Enter"] });

    // the kicked token is dead immediately, and presence is cleared
    assert.equal((await t.authed("/parent")).status, 401);
    assert.equal(t.presence.list().length, 0);
  } finally {
    await teardown(t);
  }
});

test("token mint: 403 unless [token_mint] enables it; minted tokens work immediately and persist", async () => {
  const t = await setup();
  try {
    const mint = (body: unknown) =>
      fetch(t.base + "/admin/tokens", {
        method: "POST",
        headers: { "x-admin-token": "admin-tok", "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // off by default — secure for production parents
    assert.equal((await mint({ name: "guest" })).status, 403);
    assert.equal(((await (await mint({ name: "guest" })).json()) as { code: string }).code, "mint_disabled");

    t.config.token_mint.enabled = true;
    const minted = await mint({ name: "guest" });
    assert.equal(minted.status, 200);
    const out = (await minted.json()) as { name: string; token: string };
    assert.equal(out.name, "guest");
    assert.ok(out.token.length >= 40);
    assert.equal(t.persisted.length, 1, "minted tokens persist to config.toml");

    const asGuest = await fetch(t.base + "/parent", { headers: { authorization: `Bearer ${out.token}` } });
    assert.equal(asGuest.status, 200, "the minted token authenticates immediately");

    assert.equal((await mint({ name: "guest" })).status, 400, "duplicate names are the revocation key — rejected");
    assert.equal((await mint({ name: "bad name!" })).status, 400);
  } finally {
    await teardown(t);
  }
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
