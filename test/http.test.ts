import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { hashSecret } from "../src/auth.js";
import { AuthLimiter } from "../src/auth-limit.js";
import { Audit } from "../src/audit.js";
import { EnvRegistry } from "../src/env-registry.js";
import { OwnerRegistry } from "../src/owners.js";
import { claudeCwdSlug } from "../src/transcript.js";
import { Presence } from "../src/presence.js";
import { ModelRegistry } from "../src/model-registry.js";
import { Registry } from "../src/registry.js";
import { LocalHerdr } from "../src/local-attach.js";
import { TunnelHub } from "../src/tunnel.js";
import { AgentIndex, ChildrenStore } from "../src/state.js";
import { CliProfiles } from "../src/cli-profiles.js";
import { loadConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http.js";
import { WorkspaceIndex } from "../src/state.js";
import type { OpsDeps } from "../src/workspace-ops.js";
import { FakeHerdr } from "./fake-herdr.js";
import { scratchRepo, sh, tmpDir } from "./util.js";

async function setup(opts: { limiter?: AuthLimiter; ownership?: boolean } = {}) {
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
  config.client_tokens = [
    { name: "t", token: "tok" },
    { name: "t2", token: "tok2" },
  ];
  // ownership mode: an OwnerRegistry plus a provisioner whose "herdr" is a
  // fresh FakeHerdr per session — start() returns the endpoint like the
  // real exec-based provisioner does
  const provisionedFakes = new Map<string, FakeHerdr>();
  const owners = new OwnerRegistry(tmpDir());
  const provisioner = {
    async start(name: string) {
      const fh = new FakeHerdr(join(tmpDir(), `${name}.sock`));
      await fh.listen();
      provisionedFakes.set(name, fh);
      return { session: name, socketPath: fh.socketPath };
    },
    async stop(name: string) {
      await provisionedFakes.get(name)?.close();
      provisionedFakes.delete(name);
    },
  };
  const children = new ChildrenStore(tmpDir());
  const ops: OpsDeps = {
    local,
    registry,
    index: new WorkspaceIndex(tmpDir()),
    env: new EnvRegistry({ stateDir: tmpDir() }),
    models: new ModelRegistry(),
    agents: new AgentIndex(tmpDir()),
    profiles: new CliProfiles(),
    stateDir: tmpDir(),
    askPollMs: 25,
    askGraceMs: 150,
    settleMsOverride: 0,
  };
  const persisted: string[] = [];
  const presence = new Presence();
  const audit = new Audit(join(tmpDir(), "audit.log"));
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
      ...(opts.limiter ? { limiter: opts.limiter } : {}),
      ...(opts.ownership ? { owners, provisioner } : {}),
      audit,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const authed = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: "Bearer tok", ...init.headers } });
  const authed2 = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: "Bearer tok2", ...init.headers } });
  return {
    fake, registry, local, children, server, base, authed, authed2, ops, config, persisted, presence, kicked,
    owners, provisioner, provisionedFakes,
  };
}

async function teardown(t: { server: import("node:http").Server; local: LocalHerdr; fake: FakeHerdr }) {
  t.server.close();
  t.local.stop();
  await t.fake.close();
}

test("auth rate limit: too many bad bearers earn 429 — even for the right token afterwards", async () => {
  const t = await setup({ limiter: new AuthLimiter({ maxFailures: 3, windowMs: 60_000 }) });
  try {
    for (let i = 0; i < 3; i++) {
      const bad = await fetch(t.base + "/instances", { headers: { authorization: "Bearer wrong" } });
      assert.equal(bad.status, 401);
    }
    const blocked = await fetch(t.base + "/instances", { headers: { authorization: "Bearer wrong" } });
    assert.equal(blocked.status, 429);
    assert.equal(((await blocked.json()) as { code: string }).code, "rate_limited");
    // the right token is blocked from that address too — that IS the feature
    assert.equal((await t.authed("/instances")).status, 429);
    // health stays reachable — liveness probes must never be limited
    assert.equal((await fetch(t.base + "/health")).status, 200);
  } finally {
    await teardown(t);
  }
});

test("auth rate limit: credential-less requests 401 but never count — an unauthenticated SPA must not lock out its own user", async () => {
  const t = await setup({ limiter: new AuthLimiter({ maxFailures: 3, windowMs: 60_000 }) });
  try {
    // an app polling without a token (fresh browser, gate not passed yet)
    for (let i = 0; i < 6; i++) {
      const bare = await fetch(t.base + "/instances");
      assert.equal(bare.status, 401, "always 401, never 429");
    }
    // the real login still works — no failures were recorded
    assert.equal((await t.authed("/instances")).status, 200);
    // admin without the header is the same: 401, not a counted attempt
    for (let i = 0; i < 6; i++) {
      assert.equal((await fetch(t.base + "/admin/status")).status, 401);
    }
    assert.equal((await t.authed("/instances")).status, 200);
  } finally {
    await teardown(t);
  }
});

test("auth rate limit: a successful auth clears the address's failure count", async () => {
  const t = await setup({ limiter: new AuthLimiter({ maxFailures: 3, windowMs: 60_000 }) });
  try {
    for (let i = 0; i < 2; i++) {
      await fetch(t.base + "/instances", { headers: { authorization: "Bearer wrong" } });
    }
    assert.equal((await t.authed("/instances")).status, 200, "still under the limit — real token works");
    for (let i = 0; i < 2; i++) {
      const bad = await fetch(t.base + "/instances", { headers: { authorization: "Bearer wrong" } });
      assert.equal(bad.status, 401, "counter restarted after the success");
    }
  } finally {
    await teardown(t);
  }
});

test("auth rate limit: bad admin tokens count toward the same address's limit", async () => {
  const t = await setup({ limiter: new AuthLimiter({ maxFailures: 3, windowMs: 60_000 }) });
  try {
    for (let i = 0; i < 3; i++) {
      const bad = await fetch(t.base + "/admin/status", { headers: { "x-admin-token": "wrong" } });
      assert.equal(bad.status, 401);
    }
    assert.equal((await t.authed("/instances")).status, 429);
  } finally {
    await teardown(t);
  }
});

test("audit: admin actions and env writes land in the trail, readable via GET /admin/audit", async () => {
  const t = await setup();
  try {
    t.config.token_mint.enabled = true;
    await fetch(t.base + "/admin/tokens", {
      method: "POST",
      headers: { "x-admin-token": "admin-tok", "content-type": "application/json" },
      body: JSON.stringify({ name: "guest" }),
    });
    await t.authed("/instances/runtime/env", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "SOME_KEY", value: "v", kind: "copilot" }),
    });
    await fetch(t.base + "/admin/kick/guest", { method: "POST", headers: { "x-admin-token": "admin-tok" } });

    const res = await fetch(t.base + "/admin/audit?limit=10", { headers: { "x-admin-token": "admin-tok" } });
    assert.equal(res.status, 200);
    const { entries } = (await res.json()) as { entries: { action: string; actor: string; target?: string }[] };
    assert.deepEqual(entries.map((e) => e.action), ["token.mint", "env.set", "kick"]);
    assert.equal(entries[0].actor, "admin");
    assert.equal(entries[0].target, "guest");
    // env writes are bearer-authed — the actor is the token's NAME
    assert.equal(entries[1].actor, "t");
    assert.equal(entries[1].target, "SOME_KEY");
  } finally {
    await teardown(t);
  }
});

test("health needs no auth; /instances does", async () => {
  const t = await setup();
  const health = await (await fetch(t.base + "/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.name, "herdr-web-broker");
  assert.equal((await fetch(t.base + "/instances")).status, 401);
  await teardown(t);
});

test("/v1 and the bare path are the SAME routes — the alias keeps pre-1.0 clients working", async () => {
  const t = await setup();
  const { authed } = t;

  // /health, unauthenticated, reports the API version so a client can
  // negotiate before it holds a token — and answers under both forms.
  const bare = await (await fetch(t.base + "/health")).json();
  const versioned = await (await fetch(t.base + "/v1/health")).json();
  assert.equal(bare.api_version, "v1");
  assert.deepEqual({ ...bare, pid: 0 }, { ...versioned, pid: 0 }, "same body either way");

  // An authenticated route: identical payload through both paths.
  const rollBare = await (await authed("/instances")).json();
  const rollV1 = await (await authed("/v1/instances")).json();
  assert.deepEqual(rollBare, rollV1);

  // The prefix is stripped, not merely tolerated — a deeper route still
  // resolves, so this is not a special case bolted onto the top level.
  const sBare = await (await authed("/instances/runtime/sessions/default/agents")).json();
  const sV1 = await (await authed("/v1/instances/runtime/sessions/default/agents")).json();
  assert.deepEqual(sBare, sV1);

  // Only the exact segment is a version. `/v11` is a real 404, not a strip.
  assert.equal((await authed("/v11/instances")).status, 404);
  await teardown(t);
});

test("GET grammar: rollup, instance, sessions, agents", async () => {
  const t = await setup();
  const { authed } = t;
  const roll = await (await authed("/instances")).json();
  assert.equal(roll.instances[0].instance, "runtime");
  assert.deepEqual(roll.instances[0].counts, { working: 1, blocked: 0, idle: 0 });

  const inst = await (await authed("/instances/runtime")).json();
  assert.equal(inst.herdr_version, "0.8.0-test");
  assert.deepEqual(inst.sessions, ["default"]);

  const sessions = await (await authed("/instances/runtime/sessions")).json();
  assert.deepEqual(sessions.sessions, [
    { name: "default", counts: { working: 1, blocked: 0, idle: 0 } },
  ]);

  const agents = await (await authed("/instances/runtime/sessions/default/agents")).json();
  assert.equal(agents.agents[0].id, "w1:p1");
  assert.equal((await authed("/instances/ghost")).status, 404);
  assert.equal((await authed("/instances/runtime/sessions/ghost/agents")).status, 404);
  await teardown(t);
});

test("rpc passthrough returns herdr results and relays herdr errors as 502", async () => {
  const t = await setup();
  const { authed } = t;
  const ok = await authed("/instances/runtime/sessions/default/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "agent.list", params: {} }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.agents.length, 1);

  const bad = await authed("/instances/runtime/sessions/default/rpc", {
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
  const res = await (await authed("/instances/runtime/sessions/default/agents?fresh=1")).json();
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
    const res = await authed("/instances/runtime/sessions/default/rpc", {
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
  const res = await t.authed("/instances/runtime/sessions/default/rpc", {
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
  const res = await t.authed("/instances/runtime/sessions/default/agents", {
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
  const bad = await t.authed("/instances/runtime/sessions/default/agents", {
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
  const res = await t.authed("/instances/runtime/sessions/default/agents", {
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
  const res = await t.authed("/instances/runtime/sessions/default/workspaces");
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

  const tree = await t.authed("/instances/runtime/sessions/default/workspaces/w2/repos/-/tree");
  assert.equal(tree.status, 200);
  const treeBody = (await tree.json()) as { tree: { children: { name: string }[] } };
  assert.deepEqual(treeBody.tree.children.map((c) => c.name), ["a.txt"]);

  const diff = await t.authed("/instances/runtime/sessions/default/workspaces/w2/repos/-/git/diff");
  assert.equal(diff.status, 200);
  const diffBody = (await diff.json()) as { branch: string; diff: string };
  assert.equal(diffBody.branch, "main");
  assert.match(diffBody.diff, /\+two/);

  assert.equal((await t.authed("/instances/runtime/sessions/default/workspaces/w2/repos/ghost/tree")).status, 404);
  assert.equal((await t.authed("/instances/runtime/sessions/default/workspaces/w9/repos/-/tree")).status, 404);
  assert.equal(
    (await t.authed("/instances/runtime/sessions/default/workspaces/w2/repos/-/git/diff?base=-rf")).status,
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
  const res = await t.authed("/instances/runtime/sessions/default/agents/w2%3Ap1/ask", {
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
    // the fixture's second token (t2/tok2) keeps working after t is revoked
    assert.equal((await t.authed("/instances")).status, 200, "primary token works before revocation");

    const gone = await fetch(t.base + "/admin/tokens/t", {
      method: "DELETE",
      headers: { "x-admin-token": "admin-tok" },
    });
    assert.equal(gone.status, 200);
    assert.deepEqual(await gone.json(), { revoked: "t", remaining: 1 });
    assert.equal(t.persisted.length, 1, "revocation persists through the onTokensChanged callback");

    assert.equal((await t.authed("/instances")).status, 401, "revoked token refused immediately");
    const other = await fetch(t.base + "/instances", { headers: { authorization: "Bearer tok2" } });
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

    const all = await t.authed("/instances/runtime/models");
    assert.equal(all.status, 200);
    const catalog = (await all.json()).models as { kind: string; id: string; context_window?: number }[];
    assert.ok(new Set(catalog.map((m) => m.kind)).size > 1, "unfiltered catalog spans kinds");

    const filtered = await t.authed("/instances/runtime/models?kind=claude");
    const claude = (await filtered.json()).models as { kind: string }[];
    assert.ok(claude.length > 0 && claude.every((m) => m.kind === "claude"));

    const sw = await t.authed("/instances/runtime/sessions/default/agents/w1%3Ap1/model", {
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

    const bad = await t.authed("/instances/runtime/sessions/default/agents/w1%3Ap1/model", {
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
    const res = await t.authed("/instances/runtime/sessions/default/agents/w1%3Ap1/slash/instructions", {
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

test("agent stop route: DELETE .../agents/{pane} closes the agent's pane", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("pane.close", () => ({ type: "ok" }));
    const res = await t.authed("/instances/runtime/sessions/default/agents/w1%3Ap1", { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { stopped: boolean; agent: string };
    assert.equal(body.stopped, true);
    assert.equal(body.agent, "claude");
  } finally {
    await teardown(t);
  }
});

test("wait + explain routes: POST .../wait blocks and 200s on timeout; GET .../explain passes through", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("agent.wait", () => ({
      type: "agent_info",
      agent: { pane_id: "w1:p1", agent_status: "idle" },
    }));
    const waited = await t.authed("/instances/runtime/sessions/default/agents/w1%3Ap1/wait", {
      method: "POST",
      body: JSON.stringify({ until: ["idle"], timeout_ms: 5000 }),
    });
    assert.equal(waited.status, 200);
    assert.deepEqual(await waited.json(), {
      waited: true,
      status: "idle",
      raw_status: "idle",
      evidence: "status",
      pane_id: "w1:p1",
    });

    t.fake.handlers.set("agent.explain", () => ({ type: "agent_explain", explain: { agent: "claude" } }));
    const explain = await t.authed("/instances/runtime/sessions/default/agents/w1%3Ap1/explain");
    assert.equal(explain.status, 200);
    assert.equal(((await explain.json()) as { explain: { agent: string } }).explain.agent, "claude");
  } finally {
    await teardown(t);
  }
});

test("worktree routes: GET lists via the workspace; DELETE removes checkout + workspace", async () => {
  const t = await setup();
  try {
    t.ops.index.set("default", "w1", { cwd: scratchRepo() });
    t.fake.handlers.set("worktree.list", () => ({
      type: "worktree_list",
      source: {},
      worktrees: [{ branch: "main" }, { branch: "feat-x" }],
    }));
    const list = await t.authed("/instances/runtime/sessions/default/workspaces/w1/worktrees");
    assert.equal(list.status, 200);
    assert.deepEqual(
      ((await list.json()) as { worktrees: { branch: string }[] }).worktrees.map((w) => w.branch),
      ["main", "feat-x"],
    );

    t.ops.index.set("default", "w6", { cwd: "/tmp/wt/feat-x" });
    t.fake.handlers.set("worktree.remove", () => ({ type: "worktree_removed", path: "/tmp/wt/feat-x" }));
    const rm = await t.authed("/instances/runtime/sessions/default/worktrees/w6?force=1", { method: "DELETE" });
    assert.equal(rm.status, 200);
    assert.deepEqual(await rm.json(), { workspace_id: "w6", removed: true, path: "/tmp/wt/feat-x" });
    const sent = t.fake.received.find((r) => r.method === "worktree.remove");
    assert.deepEqual(sent?.params, { workspace_id: "w6", force: true });
  } finally {
    await teardown(t);
  }
});

test("workspace close route: DELETE .../workspaces/{w} reaps it", async () => {
  const t = await setup();
  try {
    t.ops.index.set("default", "w1", { cwd: scratchRepo() });
    t.fake.handlers.set("workspace.close", () => ({ type: "ok" }));
    const res = await t.authed("/instances/runtime/sessions/default/workspaces/w1", { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { workspace_id: "w1", closed: true });
    assert.equal(t.ops.index.get("default", "w1"), undefined);
  } finally {
    await teardown(t);
  }
});

test("pane screen route: GET serves the terminal text; version+wait_ms long-polls; source passes through", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("pane.read", () => ({ type: "pane_read", read: { text: "❯ building…" } }));

    const res = await t.authed("/instances/runtime/sessions/default/panes/w1%3Ap1/screen");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { pane_id: string; source: string; text: string; version: string };
    assert.equal(body.pane_id, "w1:p1");
    assert.equal(body.source, "visible");
    assert.equal(body.text, "❯ building…");

    const idle = await t.authed(
      `/instances/runtime/sessions/default/panes/w1%3Ap1/screen?version=${body.version}&wait_ms=100`,
    );
    assert.equal(((await idle.json()) as { unchanged?: boolean }).unchanged, true);

    const recent = await t.authed("/instances/runtime/sessions/default/panes/w1%3Ap1/screen?source=recent");
    assert.equal(((await recent.json()) as { source: string }).source, "recent");
    const sent = t.fake.received.find((r) => r.method === "pane.read" && (r.params as { source: string }).source === "recent");
    assert.ok(sent, "recent source reached herdr");

    const bad = await t.authed("/instances/runtime/sessions/default/panes/w1%3Ap1/screen?source=history");
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

    const drive = await t.authed("/instances/runtime/sessions/default/agents/w1%3Ap1/spec-bundles", {
      method: "POST",
      body: JSON.stringify({ name: "checkout", prompt: "draft it" }),
    });
    assert.equal(drive.status, 201);
    const made = (await drive.json()) as { bundle: string; dir: string; files: string[]; version: string };
    assert.deepEqual(made.files, ["overview.md"]);

    const got = await t.authed(`/instances/runtime/sessions/default/workspaces/w1/spec-bundles/${made.bundle}`);
    assert.equal(got.status, 200);
    const body = (await got.json()) as { version: string; files: Record<string, { content: string }> };
    assert.ok(body.files["overview.md"].content.includes("checkout"));

    const idle = await t.authed(
      `/instances/runtime/sessions/default/workspaces/w1/spec-bundles/${made.bundle}?version=${body.version}&wait_ms=150`,
    );
    assert.equal(((await idle.json()) as { unchanged?: boolean }).unchanged, true);

    const list = await t.authed("/instances/runtime/sessions/default/workspaces/w1/spec-bundles");
    assert.deepEqual(((await list.json()) as { bundles: { bundle: string }[] }).bundles.map((b) => b.bundle), [
      made.bundle,
    ]);

    const plan = await t.authed(
      `/instances/runtime/sessions/default/agents/w1%3Ap1/spec-bundles/${made.bundle}/plan`,
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
    const res = await t.authed("/instances/runtime/sessions/default/agents/w1%3Ap1/prompt", {
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
    const ok = await t.authed("/instances/runtime/sessions/default/workspaces/w1/repos/-/file?path=a.txt");
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { content: string }).content, "one\n");
    const bad = await t.authed("/instances/runtime/sessions/default/workspaces/w1/repos/-/file?path=..%2Fescape");
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

    const commit = await t.authed("/instances/runtime/sessions/default/workspaces/w1/repos/-/git/commit", {
      method: "POST",
      body: JSON.stringify({ message: "vibe: agent work" }),
    });
    assert.equal(commit.status, 200);
    const made = (await commit.json()) as { committed: boolean; commit: string; branch: string };
    assert.equal(made.committed, true);
    assert.equal(made.branch, "main");

    const log = await t.authed("/instances/runtime/sessions/default/workspaces/w1/repos/-/git/log?limit=5");
    const commits = ((await log.json()) as { commits: { subject: string }[] }).commits;
    assert.equal(commits[0].subject, "vibe: agent work");

    const co = await t.authed("/instances/runtime/sessions/default/workspaces/w1/repos/-/git/checkout", {
      method: "POST",
      body: JSON.stringify({ ref: "feat/vibe", create: true }),
    });
    assert.deepEqual(await co.json(), { workspace_id: "w1", repo: "-", branch: "feat/vibe" });

    const push = await t.authed("/instances/runtime/sessions/default/workspaces/w1/repos/-/git/push", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const pushed = (await push.json()) as { pushed: boolean; branch: string };
    assert.equal(pushed.pushed, true);
    assert.equal(pushed.branch, "feat/vibe");

    const bad = await t.authed("/instances/runtime/sessions/default/workspaces/w1/repos/-/git/commit", {
      method: "POST",
      body: JSON.stringify({ message: "   " }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await teardown(t);
  }
});

test("context inline: ?inline=1 on upload embeds content in the prompt preamble; POST {inline} toggles it", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.ops.index.set("default", "w1", { cwd });
    const up = await t.authed("/instances/runtime/sessions/default/workspaces/w1/context/notes.md?inline=1", {
      method: "PUT",
      headers: { "content-type": "text/markdown" },
      body: "# decisions\nuse OAuth everywhere\n",
    });
    assert.equal(up.status, 201);
    assert.equal(((await up.json()) as { inline?: boolean }).inline, true);

    // the preamble that rides ask/prompt now carries the CONTENT
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    await t.authed("/instances/runtime/sessions/default/agents/w1%3Ap1/prompt", {
      method: "POST",
      body: JSON.stringify({ text: "go" }),
    });
    const sent = t.fake.received.find((r) => r.method === "agent.prompt")?.params as { text: string };
    assert.ok(sent.text.includes("use OAuth everywhere"), "inline content rides the prompt");

    // toggling inline off reverts to path-only
    const off = await t.authed("/instances/runtime/sessions/default/workspaces/w1/context/notes.md", {
      method: "POST",
      body: JSON.stringify({ inline: false }),
    });
    assert.equal(off.status, 200);
    t.fake.received.length = 0;
    await t.authed("/instances/runtime/sessions/default/agents/w1%3Ap1/prompt", {
      method: "POST",
      body: JSON.stringify({ text: "go" }),
    });
    const sent2 = t.fake.received.find((r) => r.method === "agent.prompt")?.params as { text: string };
    assert.ok(!sent2.text.includes("use OAuth everywhere"), "path-only again");
    assert.ok(sent2.text.includes("notes.md"), "still listed by path");
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

    const up = await t.authed("/instances/runtime/sessions/default/workspaces/w1/context/spec.pdf", {
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      body: bytes,
    });
    assert.equal(up.status, 201);
    assert.equal(((await up.json()) as { active: boolean }).active, true);

    const list = await t.authed("/instances/runtime/sessions/default/workspaces/w1/context");
    const attachments = ((await list.json()) as { attachments: { name: string; content_type: string }[] }).attachments;
    assert.deepEqual([attachments[0].name, attachments[0].content_type], ["spec.pdf", "application/pdf"]);

    const dl = await t.authed("/instances/runtime/sessions/default/workspaces/w1/context/spec.pdf");
    assert.equal(dl.headers.get("content-type"), "application/pdf");
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes, "binary round-trips exactly");

    const toggled = await t.authed("/instances/runtime/sessions/default/workspaces/w1/context/spec.pdf", {
      method: "POST",
      body: JSON.stringify({ active: false }),
    });
    assert.equal(((await toggled.json()) as { active: boolean }).active, false);

    const gone = await t.authed("/instances/runtime/sessions/default/workspaces/w1/context/spec.pdf", {
      method: "DELETE",
    });
    assert.equal(gone.status, 200);
    assert.equal((await t.authed("/instances/runtime/sessions/default/workspaces/w1/context/spec.pdf")).status, 404);
  } finally {
    await teardown(t);
  }
});

test("presence: POST /auth records identity; /instances shows in_use_by; kick evicts everything", async () => {
  const t = await setup();
  try {
    t.fake.agents = [{ pane_id: "w1:p1", name: "claude", agent: "claude", agent_status: "idle" }];
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));

    const id = await t.authed("/auth", {
      method: "POST",
      body: JSON.stringify({ name: "Kathia", email: "kathia@example.com" }),
    });
    assert.equal(id.status, 200);
    const entry = (await id.json()) as { token: string; name: string; email: string };
    assert.deepEqual([entry.token, entry.name, entry.email], ["t", "Kathia", "kathia@example.com"]);

    const roll = (await (await t.authed("/instances")).json()) as { in_use_by: { token: string; name: string }[] };
    assert.deepEqual(roll.in_use_by.map((u) => [u.token, u.name]), [["t", "Kathia"]]);

    const badEmail = await t.authed("/auth", { method: "POST", body: JSON.stringify({ email: "not-an-email" }) });
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
    assert.equal((await t.authed("/instances")).status, 401);
    assert.equal(t.presence.list().length, 0);
  } finally {
    await teardown(t);
  }
});

test("DELETE /auth: a token evicts ITSELF — revoked, sockets closed, presence gone, audited", async () => {
  const t = await setup();
  try {
    t.config.token_mint.enabled = true;
    const minted = (await (
      await fetch(t.base + "/admin/tokens", {
        method: "POST",
        headers: { "x-admin-token": "admin-tok", "content-type": "application/json" },
        body: JSON.stringify({ name: "me" }),
      })
    ).json()) as { token: string };
    await fetch(t.base + "/auth", {
      method: "POST",
      headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Me" }),
    });
    assert.ok(t.presence.list().some((e) => e.token === "me"));

    const res = await fetch(t.base + "/auth", {
      method: "DELETE",
      headers: { authorization: `Bearer ${minted.token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { signed_out: string; token_revoked: boolean; sockets_closed: number };
    assert.equal(body.signed_out, "me");
    assert.equal(body.token_revoked, true);
    assert.equal(body.sockets_closed, 2); // the harness's onKickSockets answers 2
    assert.ok(t.kicked.includes("me"), "live WS sockets for the token were closed");
    assert.equal(t.presence.list().some((e) => e.token === "me"), false);
    assert.ok(t.persisted.length >= 2, "revocation persisted via onTokensChanged");

    // dead everywhere — and the OTHER token is untouched
    const after = await fetch(t.base + "/instances", { headers: { authorization: `Bearer ${minted.token}` } });
    assert.equal(after.status, 401);
    assert.equal((await t.authed("/instances")).status, 200);

    const audit = (await (
      await fetch(t.base + "/admin/audit?limit=10", { headers: { "x-admin-token": "admin-tok" } })
    ).json()) as { entries: { action: string; actor: string }[] };
    assert.ok(audit.entries.some((e) => e.action === "auth.self_kick" && e.actor === "me"));
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

    const asGuest = await fetch(t.base + "/instances", { headers: { authorization: `Bearer ${out.token}` } });
    assert.equal(asGuest.status, 200, "the minted token authenticates immediately");

    // show-once: only the sha256 of the token is stored — the plaintext
    // exists nowhere but the mint response
    const entry = t.config.client_tokens.find((c) => c.name === "guest");
    assert.equal(entry?.token, undefined, "no plaintext at rest");
    assert.equal(entry?.token_hash, hashSecret(out.token));

    assert.equal((await mint({ name: "guest" })).status, 400, "duplicate names are the revocation key — rejected");
    assert.equal((await mint({ name: "bad name!" })).status, 400);
  } finally {
    await teardown(t);
  }
});

test("env routes: store, list (redacted, with source), delete; value absent everywhere", async () => {
  const t = await setup();
  try {
    const post = await t.authed("/instances/runtime/env", {
      method: "POST",
      body: JSON.stringify({ name: "COPILOT_GITHUB_TOKEN", value: "super-sekret", kind: "copilot" }),
    });
    assert.equal(post.status, 200);
    const stored = await post.json();
    assert.deepEqual(stored, { status: "stored", name: "COPILOT_GITHUB_TOKEN", scope: { kind: "copilot" } });

    const list = await t.authed("/instances/runtime/env");
    const body = await list.text();
    assert.ok(!body.includes("super-sekret"), "value must never appear in responses");
    const vars = JSON.parse(body).vars as { name: string; source: string }[];
    assert.deepEqual(vars.map((v) => [v.name, v.source]), [["COPILOT_GITHUB_TOKEN", "manual"]]);

    const del = await t.authed("/instances/runtime/env/COPILOT_GITHUB_TOKEN?kind=copilot", { method: "DELETE" });
    assert.equal(del.status, 200);
    const delAgain = await t.authed("/instances/runtime/env/COPILOT_GITHUB_TOKEN?kind=copilot", { method: "DELETE" });
    assert.equal(delAgain.status, 404);
  } finally {
    await teardown(t);
  }
});

test("env routes: bad name 400, unauthenticated 401, disabled 403", async () => {
  const t = await setup();
  try {
    const bad = await t.authed("/instances/runtime/env", {
      method: "POST",
      body: JSON.stringify({ name: "not-valid", value: "v" }),
    });
    assert.equal(bad.status, 400);
    const anon = await fetch(t.base + "/instances/runtime/env");
    assert.equal(anon.status, 401);
    (t.ops as { env: EnvRegistry }).env = new EnvRegistry({ stateDir: tmpDir(), enabled: false });
    const off = await t.authed("/instances/runtime/env");
    assert.equal(off.status, 403);
  } finally {
    await teardown(t);
  }
});

test("ownership: /auth with email provisions an owned herdr; binding is sticky; another token gets 409", async () => {
  const t = await setup({ ownership: true });
  try {
    const first = await t.authed("/auth", { method: "POST", body: JSON.stringify({ email: "kathia@example.com" }) });
    assert.equal(first.status, 200);
    const b1 = (await first.json()) as { session?: string; provisioned?: boolean };
    assert.ok(b1.session?.startsWith("u-"), `owned session provisioned, got ${JSON.stringify(b1)}`);
    assert.equal(b1.provisioned, true);
    assert.ok(t.local.sessions().includes(b1.session!), "the broker serves the new session immediately");

    // same token identifying again: same session, not re-provisioned
    const again = await t.authed("/auth", { method: "POST", body: JSON.stringify({ email: "kathia@example.com" }) });
    const b2 = (await again.json()) as { session?: string; provisioned?: boolean };
    assert.equal(b2.session, b1.session);
    assert.equal(b2.provisioned, false);

    // sticky: a different token claiming the email is refused
    const conflict = await t.authed2("/auth", { method: "POST", body: JSON.stringify({ email: "kathia@example.com" }) });
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { code: string }).code, "email_taken");

    // email-less identify stays pure presence, as before
    const plain = await t.authed2("/auth", { method: "POST", body: JSON.stringify({ name: "visitor" }) });
    assert.equal(plain.status, 200);
    assert.equal(((await plain.json()) as { session?: string }).session, undefined);
  } finally {
    await teardown(t);
    for (const fh of t.provisionedFakes.values()) await fh.close();
  }
});

test("ownership: an owned session is invisible to other bearers — 404 like a ghost, hidden from lists", async () => {
  const t = await setup({ ownership: true });
  try {
    const auth = await t.authed("/auth", { method: "POST", body: JSON.stringify({ email: "kathia@example.com" }) });
    const { session } = (await auth.json()) as { session: string };

    // the owner reaches it
    const mine = await t.authed(`/instances/runtime/sessions/${session}/agents`);
    assert.equal(mine.status, 200);

    // another bearer gets EXACTLY what a nonexistent session yields — no oracle
    const theirs = await t.authed2(`/instances/runtime/sessions/${session}/agents`);
    const ghost = await t.authed2(`/instances/runtime/sessions/no-such-session/agents`);
    assert.equal(theirs.status, 404);
    assert.equal(ghost.status, 404);
    assert.equal(
      ((await theirs.json()) as { code: string }).code,
      ((await ghost.json()) as { code: string }).code,
    );

    // lists hide it from non-owners, show it to the owner; default stays shared
    const rosterOther = (await (await t.authed2("/instances/runtime")).json()) as { sessions: string[] };
    assert.ok(!rosterOther.sessions.includes(session));
    assert.ok(rosterOther.sessions.includes("default"));
    const rosterOwner = (await (await t.authed("/instances/runtime")).json()) as { sessions: string[] };
    assert.ok(rosterOwner.sessions.includes(session));

    const listOther = (await (await t.authed2("/instances/runtime/sessions")).json()) as {
      sessions: { name: string }[];
    };
    assert.ok(!listOther.sessions.some((s) => s.name === session));
  } finally {
    await teardown(t);
    for (const fh of t.provisionedFakes.values()) await fh.close();
  }
});

test("ownership teardown: closes workspaces, stops the herdr, prunes the roster, frees the binding — default is untouchable", async () => {
  const t = await setup({ ownership: true });
  try {
    const auth = await t.authed("/auth", { method: "POST", body: JSON.stringify({ email: "kathia@example.com" }) });
    const { session } = (await auth.json()) as { session: string };
    const owned = t.provisionedFakes.get(session)!;
    const closedIds: string[] = [];
    owned.handlers.set("workspace.list", () => ({ type: "workspace_list", workspaces: [{ workspace_id: "w9" }] }));
    owned.handlers.set("workspace.close", (p) => {
      closedIds.push(String((p as { workspace_id?: string })?.workspace_id));
      return { type: "workspace_closed" };
    });
    t.ops.agents.set(session, "w9:p1", { kind: "claude", startedAt: 0 });

    // a non-owner cannot even see the session to tear it down
    const denied = await t.authed2(`/instances/runtime/sessions/${session}`, { method: "DELETE" });
    assert.equal(denied.status, 404);

    // the INVARIANT: the primary herdr hosting the API can never be stopped
    const primary = await t.authed(`/instances/runtime/sessions/default`, { method: "DELETE" });
    assert.equal(primary.status, 400);
    assert.ok(t.local.sessions().includes("default"));

    const down = await t.authed(`/instances/runtime/sessions/${session}`, { method: "DELETE" });
    assert.equal(down.status, 200);
    const body = (await down.json()) as { torn_down: string; workspaces_closed: number };
    assert.equal(body.torn_down, session);
    assert.equal(body.workspaces_closed, 1);
    assert.deepEqual(closedIds, ["w9"], "agents died with their workspaces");
    assert.ok(!t.local.sessions().includes(session), "actively deregistered, not left to rot");
    assert.equal(t.provisionedFakes.has(session), false, "the herdr process was stopped");
    assert.equal(t.ops.agents.get(session, "w9:p1"), undefined, "agent rows torn down with the session");

    // the binding is freed: the same email provisions FRESH next time
    const rebirth = await t.authed("/auth", { method: "POST", body: JSON.stringify({ email: "kathia@example.com" }) });
    const b = (await rebirth.json()) as { session: string; provisioned: boolean };
    assert.equal(b.provisioned, true);
    assert.equal(b.session, session, "deterministic name survives the cycle");
  } finally {
    await teardown(t);
    for (const fh of t.provisionedFakes.values()) await fh.close();
  }
});

test("ownership teardown clears the WORKSPACE index too, not just the agent index", async () => {
  // Roadmap 25(a). demolishOwned called agents.removeSession but never
  // touched WorkspaceIndex, while broker.workspace.close clears both — the
  // sibling stores disagreed at that one call site. It matters because the
  // session name is deterministic: the same email re-provisions the SAME
  // name, so a surviving row is inherited by the new session, and
  // resolveCwd falls back to the index when herdr doesn't list a workspace
  // — handing a repo endpoint a path from a session that no longer exists.
  const t = await setup({ ownership: true });
  try {
    const auth = await t.authed("/auth", { method: "POST", body: JSON.stringify({ email: "milo@example.com" }) });
    const { session } = (await auth.json()) as { session: string };
    const owned = t.provisionedFakes.get(session)!;
    owned.handlers.set("workspace.list", () => ({ type: "workspace_list", workspaces: [{ workspace_id: "w9" }] }));
    owned.handlers.set("workspace.close", () => ({ type: "workspace_closed" }));

    t.ops.index.set(session, "w9", { cwd: "/gone/listed" });
    // the row herdr no longer lists — the one that survived even a
    // per-workspace cleanup, because nothing iterated it
    t.ops.index.set(session, "w4", { cwd: "/gone/unlisted" });

    const down = await t.authed(`/instances/runtime/sessions/${session}`, { method: "DELETE" });
    assert.equal(down.status, 200);
    assert.deepEqual(
      t.ops.index.all(session),
      {},
      "the herdr PROCESS died; every workspace row for it goes too, listed or not",
    );

    const rebirth = await t.authed("/auth", { method: "POST", body: JSON.stringify({ email: "milo@example.com" }) });
    const b = (await rebirth.json()) as { session: string };
    assert.equal(b.session, session, "same deterministic name — which is why the stale row would have been inherited");
    assert.deepEqual(t.ops.index.all(b.session), {}, "the reborn session starts clean");
  } finally {
    await teardown(t);
    for (const fh of t.provisionedFakes.values()) await fh.close();
  }
});

test("ownership admin: GET /admin/owners lists bindings; rebind moves an email to a new token", async () => {
  const t = await setup({ ownership: true });
  try {
    await t.authed("/auth", { method: "POST", body: JSON.stringify({ email: "kathia@example.com" }) });
    const admin = (path: string, init: RequestInit = {}) =>
      fetch(t.base + path, { ...init, headers: { "x-admin-token": "admin-tok", ...init.headers } });

    const list = await admin("/admin/owners");
    assert.equal(list.status, 200);
    const owners = (await list.json()) as { owners: { email: string; session: string; token: string }[] };
    assert.equal(owners.owners[0]?.email, "kathia@example.com");

    // rebind: t2 takes over the email (lost device); t2 now reaches the session
    const re = await admin("/admin/owners/kathia%40example.com", {
      method: "POST",
      body: JSON.stringify({ token: "t2" }),
    });
    assert.equal(re.status, 200);
    const session = owners.owners[0].session;
    assert.equal((await t.authed2(`/instances/runtime/sessions/${session}/agents`)).status, 200);
    assert.equal((await t.authed(`/instances/runtime/sessions/${session}/agents`)).status, 404);
  } finally {
    await teardown(t);
    for (const fh of t.provisionedFakes.values()) await fh.close();
  }
});

test("ownership admin kill: DELETE /admin/owners/{email} ends the user's herdr — never the primary", async () => {
  const t = await setup({ ownership: true });
  try {
    const auth = await t.authed("/auth", { method: "POST", body: JSON.stringify({ email: "kathia@example.com" }) });
    const { session } = (await auth.json()) as { session: string };
    const owned = t.provisionedFakes.get(session)!;
    const closedIds: string[] = [];
    owned.handlers.set("workspace.list", () => ({ type: "workspace_list", workspaces: [{ workspace_id: "w3" }] }));
    owned.handlers.set("workspace.close", (p) => {
      closedIds.push(String((p as { workspace_id?: string })?.workspace_id));
      return { type: "workspace_closed" };
    });
    const admin = (path: string, init: RequestInit = {}) =>
      fetch(t.base + path, { ...init, headers: { "x-admin-token": "admin-tok", ...init.headers } });

    // an unknown email is a 404, not a silent success
    assert.equal((await admin("/admin/owners/ghost%40example.com", { method: "DELETE" })).status, 404);

    const kill = await admin("/admin/owners/kathia%40example.com", { method: "DELETE" });
    assert.equal(kill.status, 200);
    const body = (await kill.json()) as { torn_down: string; workspaces_closed: number; token_revoked: boolean };
    assert.equal(body.torn_down, session);
    assert.equal(body.token_revoked, true, "kill invalidates the bound access token");
    assert.deepEqual(closedIds, ["w3"]);
    assert.ok(!t.local.sessions().includes(session), "herdr eliminated");
    assert.ok(t.local.sessions().includes("default"), "the primary keeps serving — the invariant holds");
    assert.equal(t.provisionedFakes.has(session), false);
    assert.deepEqual(t.kicked, ["t"], "the killed user's live sockets were closed");
    // the token is dead everywhere, and the binding is freed
    assert.equal((await t.authed("/instances")).status, 401);
    assert.equal(t.owners.byEmail("kathia@example.com"), undefined);
  } finally {
    await teardown(t);
    for (const fh of t.provisionedFakes.values()) await fh.close();
  }
});

test("git verbs over HTTP: pull fast-forwards, stash round-trips, discard needs its preview hash and audits", async () => {
  const t = await setup();
  try {
    // a clone with a real origin so pull has something to fetch
    const origin = scratchRepo();
    const parent = tmpDir();
    sh(parent, ["clone", "-q", origin, "w"]);
    const cwd = join(parent, "w");
    sh(cwd, ["config", "user.email", "t@test"]);
    sh(cwd, ["config", "user.name", "t"]);
    t.ops.index.set("default", "w1", { cwd });
    const base = "/instances/runtime/sessions/default/workspaces/w1/repos/-";

    // pull: origin advanced, the clone fast-forwards through the API
    writeFileSync(join(origin, "b.txt"), "upstream\n");
    sh(origin, ["add", "."]);
    sh(origin, ["commit", "-qm", "upstream"]);
    const pull = await t.authed(`${base}/git/pull`, { method: "POST", body: "{}" });
    assert.equal(pull.status, 200);
    assert.equal(((await pull.json()) as { pulled: boolean }).pulled, true);

    // stash: push → list → pop
    writeFileSync(join(cwd, "a.txt"), "wip\n");
    const st = await t.authed(`${base}/git/stash`, { method: "POST", body: JSON.stringify({ message: "wip" }) });
    assert.equal(((await st.json()) as { stashed: boolean }).stashed, true);
    const list = (await (await t.authed(`${base}/git/stash`)).json()) as { stashes: { subject: string }[] };
    assert.equal(list.stashes.length, 1);
    const pop = await t.authed(`${base}/git/stash/pop`, { method: "POST", body: "{}" });
    assert.equal(((await pop.json()) as { popped: boolean }).popped, true);

    // discard: preview → confirm; the executed discard lands in the audit
    const prev = (await (
      await t.authed(`${base}/git/discard`, { method: "POST", body: JSON.stringify({ all: true }) })
    ).json()) as { would_discard: string[]; confirm: string };
    assert.deepEqual(prev.would_discard, ["a.txt"]);
    const done = await t.authed(`${base}/git/discard`, {
      method: "POST",
      body: JSON.stringify({ all: true, confirm: prev.confirm }),
    });
    assert.equal(((await done.json()) as { discarded: boolean }).discarded, true);
    const audit = (await (
      await fetch(t.base + "/admin/audit", { headers: { "x-admin-token": "admin-tok" } })
    ).json()) as { entries: { action: string; actor: string }[] };
    assert.ok(audit.entries.some((e) => e.action === "git.discard" && e.actor === "t"), "executed discard audited");
  } finally {
    await teardown(t);
  }
});

const EV_TERMINAL = { done: ["end_turn", "stop_sequence", "max_tokens", "refusal"], blocked: ["tool_use"], running: [] };

/** Seeds a claude agent whose transcript proves a finished turn, under a
 * {cwdSlug} template so the read genuinely depends on cwd resolution. */
function seedTranscript(t: Awaited<ReturnType<typeof setup>>, cwd: string, pane: string, sessionId: string): void {
  const dir = join(tmpDir(), `ev-${sessionId}`);
  mkdirSync(join(dir, claudeCwdSlug(cwd)), { recursive: true });
  t.ops.profiles = new CliProfiles({
    profiles: [
      {
        kind: "claude",
        pin: { flag: "--session-id" },
        transcript: { via: "path", template: join(dir, "{cwdSlug}", "{sessionId}.jsonl") },
        terminal: EV_TERMINAL,
      },
    ],
  });
  t.ops.index.set("default", pane.split(":")[0], { cwd });
  t.ops.agents.set("default", pane, { sessionId, kind: "claude", startedAt: 0 });
  writeFileSync(
    join(dir, claudeCwdSlug(cwd), `${sessionId}.jsonl`),
    '{"type":"assistant","timestamp":"2030-01-01T00:00:00.000Z","message":{"role":"assistant","stop_reason":"end_turn"}}\n',
  );
}

test("GET agents: the default roster stays a free registry read, with no evidence field", async () => {
  // Roadmap 25(c). The whole reason evidence is opt-in: this endpoint is the
  // one a UI polls, and today it touches no disk and no herdr.
  const t = await setup();
  try {
    seedTranscript(t, "/work/proj", "w1:p1", "sid-plain");
    const before = t.fake.received.length;
    const body = (await (await t.authed("/instances/runtime/sessions/default/agents")).json()) as {
      agents: Array<{ id: string; evidence?: string }>;
    };
    assert.equal(body.agents[0].evidence, undefined, "no evidence field unless asked for");
    assert.equal(t.fake.received.length, before, "and not one call to herdr");
  } finally {
    await teardown(t);
  }
});

test("GET agents?evidence=1: a transcript decides the status and names itself as the tier", async () => {
  const t = await setup();
  try {
    seedTranscript(t, "/work/proj", "w1:p1", "sid-ev");
    t.fake.handlers.set("workspace.list", () => ({
      type: "workspace_list",
      workspaces: [{ workspace_id: "w1", cwd: "/work/proj" }],
    }));
    const body = (await (await t.authed("/instances/runtime/sessions/default/agents?evidence=1")).json()) as {
      agents: Array<{ id: string; status: string; evidence?: string }>;
    };
    const a = body.agents.find((x) => x.id === "w1:p1")!;
    assert.equal(a.evidence, "transcript");
    assert.equal(a.status, "idle", "the transcript decided it, exactly as it does on wait");
  } finally {
    await teardown(t);
  }
});

test("GET agents?evidence=1: no transcript means the status tier decided, and says so", async () => {
  const t = await setup();
  try {
    // an agent the broker has no AgentIndex row for at all
    const body = (await (await t.authed("/instances/runtime/sessions/default/agents?evidence=1")).json()) as {
      agents: Array<{ id: string; evidence?: string }>;
    };
    assert.equal(body.agents[0].evidence, "status");
  } finally {
    await teardown(t);
  }
});

test("GET agents?evidence=1 on a FEDERATED instance omits evidence rather than claiming 'status'", async () => {
  // The transcripts live on the CHILD's disk. Reporting "status" here would
  // be indistinguishable from "computed, found nothing" — the same ambiguity
  // that hid 25(b) for weeks. Absent means "not computable on this side".
  const t = await setup();
  try {
    t.registry.replaceSnapshot("laptop", {
      platform: "macos",
      herdr_version: "0.8.0-test",
      sessions: [{ name: "default", agents: [{ id: "w1:p1", title: "claude", status: "working" as const }] }],
    });
    const body = (await (await t.authed("/instances/laptop/sessions/default/agents?evidence=1")).json()) as {
      agents: Array<{ id: string; status: string; evidence?: string }>;
    };
    assert.equal(body.agents[0].evidence, undefined, "absent, not 'status'");
    assert.equal(body.agents[0].status, "working", "the roster itself is untouched");
  } finally {
    await teardown(t);
  }
});

test("GET .../orphans wires classifySession to the HTTP surface", async () => {
  // Roadmap 25(g). classifySession is fully unit-tested; this is the wiring —
  // that the route reaches it, feeds it herdr's live list and the broker's
  // index in the right order, and returns all three buckets.
  const t = await setup();
  try {
    t.ops.index.set("default", "w1", { cwd: "/work/known-and-live" });
    t.ops.index.set("default", "w2", { cwd: "/work/known-but-gone" });
    t.fake.handlers.set("workspace.list", () => ({
      type: "workspace_list",
      workspaces: [{ workspace_id: "w1", cwd: "/work/known-and-live" }, { workspace_id: "w3", cwd: "/work/never-indexed" }],
    }));

    const body = (await (await t.authed("/instances/runtime/sessions/default/orphans")).json()) as {
      session: string;
      adopt: string[];
      forget: string[];
      orphans: string[];
    };
    assert.equal(body.session, "default");
    assert.deepEqual(body.adopt, ["w1"], "indexed AND live");
    assert.deepEqual(body.forget, ["w2"], "indexed but herdr no longer lists it");
    assert.deepEqual(body.orphans, ["w3"], "live but the broker never indexed it");
  } finally {
    await teardown(t);
  }
});

test("teardown reports unrecognized workspaces, and still closes them", async () => {
  // Two things at once. The `unrecognized` field is the orphans bucket
  // computed against the PRE-teardown index — if the index were cleared
  // before classifySession ran, `known` would be empty and EVERY live
  // workspace would read as unrecognized. 25(a) added that clear to the end
  // of this same function, so this assertion is the ordering guard.
  //
  // And report-never-reap: an unrecognized workspace is still closed, because
  // the herdr process dies immediately after regardless — declining to close
  // it would only turn a graceful close into an abrupt kill.
  const t = await setup({ ownership: true });
  try {
    const auth = await t.authed("/auth", { method: "POST", body: JSON.stringify({ email: "nadia@example.com" }) });
    const { session } = (await auth.json()) as { session: string };
    const owned = t.provisionedFakes.get(session)!;
    const closed: string[] = [];
    owned.handlers.set("workspace.list", () => ({
      type: "workspace_list",
      workspaces: [{ workspace_id: "w9" }, { workspace_id: "w5" }],
    }));
    owned.handlers.set("workspace.close", (p) => {
      closed.push(String((p as { workspace_id?: string })?.workspace_id));
      return { type: "workspace_closed" };
    });
    // the broker knows about w9 only; w5 is live but was never indexed
    t.ops.index.set(session, "w9", { cwd: "/work/known" });

    const down = await t.authed(`/instances/runtime/sessions/${session}`, { method: "DELETE" });
    assert.equal(down.status, 200);
    const body = (await down.json()) as { unrecognized: string[]; workspaces_closed: number };

    assert.deepEqual(body.unrecognized, ["w5"], "only the un-indexed one — not every live workspace");
    assert.equal(body.workspaces_closed, 2, "report-never-reap: unrecognized still gets closed");
    assert.deepEqual(closed.sort(), ["w5", "w9"]);
  } finally {
    await teardown(t);
    for (const fh of t.provisionedFakes.values()) await fh.close();
  }
});
