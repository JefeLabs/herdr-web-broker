import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Registry } from "../src/registry.js";
import { LocalHerdr } from "../src/local-attach.js";
import { TunnelHub } from "../src/tunnel.js";
import { ChildrenStore } from "../src/state.js";
import { loadConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir } from "./util.js";

async function setup() {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  fake.agents = [{ id: "a1", title: "claude", status: "working" }];
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
  const server = createServer(
    createHttpHandler({
      registry,
      local,
      hub: new TunnelHub(),
      children,
      config,
      adminToken: "admin-tok",
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const authed = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: "Bearer tok", ...init.headers } });
  return { fake, registry, local, children, server, base, authed };
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
  assert.equal(agents.agents[0].id, "a1");
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
  fake.agents = [{ id: "a1", title: "claude", status: "blocked" }];
  const res = await (await authed("/parent/runtime/sessions/default/agents?fresh=1")).json();
  assert.equal(res.agents[0].status, "blocked");
  assert.deepEqual(registry.counts("runtime"), { working: 0, blocked: 1, idle: 0 });
  await teardown(t);
});

test("admin: token-gated child minting and revocation", async () => {
  const t = await setup();
  const { base, children } = t;
  assert.equal((await fetch(base + "/admin/status")).status, 401);
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
