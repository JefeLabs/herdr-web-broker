import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Audit } from "../src/audit.js";
import { BrokerEvents } from "../src/broker-events.js";
import { CliProfiles } from "../src/cli-profiles.js";
import { loadConfig } from "../src/config.js";
import { EnvRegistry } from "../src/env-registry.js";
import { createHttpHandler } from "../src/http.js";
import { LocalHerdr } from "../src/local-attach.js";
import { ModelRegistry } from "../src/model-registry.js";
import { loadModules, type ModuleSpec } from "../src/module-loader.js";
import { Presence } from "../src/presence.js";
import { Registry } from "../src/registry.js";
import { AgentIndex, ChildrenStore, ResumableIndex, WorkspaceIndex } from "../src/state.js";
import { TunnelHub } from "../src/tunnel.js";
import type { OpsDeps } from "../src/workspace-ops.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir } from "./util.js";

/** A minimal daemon-shaped harness — just enough surface to exercise
 * module dispatch through the real createHttpHandler. */
async function setup(specs: ModuleSpec[]) {
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
  const ops: OpsDeps = {
    local,
    registry,
    index: new WorkspaceIndex(tmpDir()),
    env: new EnvRegistry({ stateDir: tmpDir() }),
    models: new ModelRegistry(),
    agents: new AgentIndex(tmpDir()),
    resumable: new ResumableIndex(tmpDir()),
    profiles: new CliProfiles(),
    stateDir: tmpDir(),
    settleMsOverride: 0,
  };
  const audit = new Audit(join(tmpDir(), "audit.log"));
  const brokerEvents = new BrokerEvents();
  const modules = await loadModules(specs, {
    deps: ops,
    session: "default",
    instance: "runtime",
    events: brokerEvents,
    log: () => {},
    audit,
  });

  const server = createServer(
    createHttpHandler({
      registry,
      local,
      hub: new TunnelHub(),
      children: new ChildrenStore(tmpDir()),
      config,
      adminToken: "admin-tok",
      ops,
      presence: new Presence(),
      audit,
      modules,
      brokerEvents,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    modules,
    authed: (p: string, init: RequestInit = {}) =>
      fetch(base + p, { ...init, headers: { authorization: "Bearer tok", ...init.headers } }),
    admin: (p: string, init: RequestInit = {}) =>
      fetch(base + p, { ...init, headers: { "x-admin-token": "admin-tok", ...init.headers } }),
    teardown: async () => {
      server.close();
      local.stop();
      await fake.close();
    },
  };
}

function writeModule(name: string, body: string): string {
  const p = join(tmpDir(), name);
  writeFileSync(p, body);
  return p;
}

test("a module route answers under /v1/modules/{id} and AUTH IS NOT DELEGATED", async () => {
  const p = writeModule(
    "ping.js",
    `export default { id: "ping", abi: 1, capabilities: [],
       register(api) { api.route("GET", "/ping", async (ctx) => ({ pong: ctx.tokenName })); } };`,
  );
  const t = await setup([{ path: p, capabilities: [] }]);
  try {
    assert.equal((await fetch(t.base + "/v1/modules/ping/ping")).status, 401, "a module cannot opt out of auth");
    const r = await t.authed("/v1/modules/ping/ping");
    assert.equal(r.status, 200);
    // The handler receives the token NAME, never the token itself.
    assert.equal(((await r.json()) as { pong: string }).pong, "t");
  } finally {
    await t.teardown();
  }
});

test("the unversioned alias reaches module routes too", async () => {
  const p = writeModule(
    "alias.js",
    `export default { id: "alias", abi: 1, capabilities: [],
       register(api) { api.route("GET", "/x", async () => ({ ok: true })); } };`,
  );
  const t = await setup([{ path: p, capabilities: [] }]);
  try {
    assert.equal((await t.authed("/modules/alias/x")).status, 200);
    assert.equal((await t.authed("/v1/modules/alias/x")).status, 200);
  } finally {
    await t.teardown();
  }
});

test("params and query reach the handler", async () => {
  const p = writeModule(
    "echo.js",
    `export default { id: "echo", abi: 1, capabilities: [],
       register(api) { api.route("GET", "/r/:repo", async (ctx) => ({ repo: ctx.params.repo, f: ctx.query.get("f") })); } };`,
  );
  const t = await setup([{ path: p, capabilities: [] }]);
  try {
    const body = (await (await t.authed("/v1/modules/echo/r/myrepo?f=a.txt")).json()) as Record<string, string>;
    assert.equal(body.repo, "myrepo");
    assert.equal(body.f, "a.txt");
  } finally {
    await t.teardown();
  }
});

test("a THROWING handler yields an error response and the broker serves the next request", async () => {
  const p = writeModule(
    "boom.js",
    `export default { id: "boom", abi: 1, capabilities: [],
       register(api) { api.route("GET", "/x", async () => { throw new Error("handler boom"); }); } };`,
  );
  const t = await setup([{ path: p, capabilities: [] }]);
  try {
    assert.ok((await t.authed("/v1/modules/boom/x")).status >= 400, "the request fails");
    assert.equal((await fetch(t.base + "/health")).status, 200, "the daemon survived");
  } finally {
    await t.teardown();
  }
});

test("a FAILED module's routes 404 while the broker keeps serving", async () => {
  const bad = writeModule("bad.js", `export default { id: "bad", abi: 77, capabilities: [], register() {} };`);
  const t = await setup([{ path: bad, capabilities: [] }]);
  try {
    // 404, not 400: the matcher declines, the path falls through to the
    // broker's no-such-route handler, and a refused module is therefore
    // indistinguishable from one that was never configured. That is the
    // right shape — a caller learns the endpoint is not there, and
    // /admin/modules is where the REASON lives.
    assert.equal((await t.authed("/v1/modules/bad/anything")).status, 404);
    assert.equal((await fetch(t.base + "/health")).status, 200);
  } finally {
    await t.teardown();
  }
});

test("GET /admin/modules reports loaded AND failed modules", async () => {
  const good = writeModule(
    "g.js",
    `export default { id: "g", abi: 1, capabilities: ["files"],
       register(api) { api.route("GET", "/a", async () => ({})); } };`,
  );
  const bad = writeModule("b.js", `export default { id: "b", abi: 77, capabilities: [], register() {} };`);
  const t = await setup([
    { path: good, capabilities: ["files"] },
    { path: bad, capabilities: [] },
  ]);
  try {
    const body = (await (await t.admin("/admin/modules")).json()) as {
      modules: Array<{ id: string; granted: string[]; routes: number; error?: string }>;
    };
    const g = body.modules.find((m) => m.id === "g")!;
    const b = body.modules.find((m) => m.id === "b")!;
    assert.deepEqual(g.granted, ["files"]);
    assert.equal(g.routes, 1);
    assert.match(b.error!, /abi/i);
  } finally {
    await t.teardown();
  }
});

test("there is NO route that installs a module — config-only, asserted", async () => {
  const t = await setup([]);
  try {
    // If any of these ever becomes a working install path, the whole
    // security model collapses: a module is in-process code, so a bearer
    // token that could install one would be a remote shell.
    for (const [method, path] of [
      ["POST", "/admin/modules"],
      ["PUT", "/admin/modules"],
      ["DELETE", "/admin/modules/x"],
      ["POST", "/v1/modules"],
      ["POST", "/modules"],
    ] as const) {
      const r = await t.admin(path, { method });
      assert.ok(r.status >= 400, `${method} ${path} must not be a working install path (got ${r.status})`);
    }
  } finally {
    await t.teardown();
  }
});
