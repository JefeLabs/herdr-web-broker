import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Registry } from "../src/registry.js";
import { LocalHerdr, mapAgentList, mapHerdrEvent } from "../src/local-attach.js";
import { BrokerError } from "../src/errors.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir, waitFor } from "./util.js";

async function setup() {
  const dir = tmpDir();
  const fake = new FakeHerdr(join(dir, "h.sock"));
  fake.agents = [{ pane_id: "w1:p1", name: "claude", agent_status: "working" }];
  await fake.listen();
  const registry = new Registry();
  const local = new LocalHerdr({
    registry,
    herdrVersion: "0.8.0-test",
    endpoints: [{ session: "default", socketPath: fake.socketPath }],
  });
  await local.start();
  return { fake, registry, local };
}

test("adapters map herdr 0.8.0's real shapes and reject junk", () => {
  assert.deepEqual(
    mapAgentList({ type: "agent_list", agents: [{ pane_id: "w1:p1", name: "t", agent_status: "blocked" }] }),
    [{ id: "w1:p1", title: "t", status: "blocked" }],
  );
  assert.deepEqual(mapAgentList({ nope: 1 }), []);
  assert.deepEqual(
    mapHerdrEvent({
      event: "pane_agent_status_changed",
      data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "idle", agent: "claude" },
    }),
    { agent: { id: "w1:p1", title: "claude", status: "idle" } },
  );
  assert.deepEqual(
    mapHerdrEvent({ event: "pane_agent_detected", data: { pane_id: "w1:p1", agent: "copilot" } }),
    { refresh: true },
  );
  assert.equal(mapHerdrEvent({ event: "workspace_created", data: {} }), undefined);
  // herdr's five-valued vocabulary (done/unknown) folds into idle
  assert.deepEqual(
    mapHerdrEvent({
      event: "pane_agent_status_changed",
      data: { pane_id: "w1:p1", workspace_id: "w1", agent_status: "done" },
    }),
    { agent: { id: "w1:p1", title: "w1:p1", status: "idle" } },
  );
});

test("start subscribes, snapshots runtime into the registry, and rpc round-trips", async () => {
  const { fake, registry, local } = await setup();
  assert.deepEqual(local.sessions(), ["default"]);
  assert.ok(fake.received.some((r) => r.method === "events.subscribe"));
  const entry = registry.get("runtime");
  assert.ok(entry?.online);
  assert.equal(entry.herdr_version, "0.8.0-test");
  assert.deepEqual(registry.counts("runtime"), { working: 1, blocked: 0, idle: 0 });
  const result = (await local.request("default", "agent.list", {})) as { agents: unknown[] };
  assert.equal(result.agents.length, 1);
  local.stop();
  await fake.close();
});

test("herdr errors and unknown sessions become BrokerErrors", async () => {
  const { fake, local } = await setup();
  await assert.rejects(
    () => local.request("default", "no.such.method", {}),
    (e: BrokerError) => e.code === "not_found",
  );
  await assert.rejects(
    () => local.request("ghost", "ping", {}),
    (e: BrokerError) => e.code === "unknown_session",
  );
  local.stop();
  await fake.close();
});

test("streamed status events update the runtime registry entry", async () => {
  const { fake, registry, local } = await setup();
  fake.emitEvent("pane_agent_status_changed", {
    pane_id: "w1:p1",
    workspace_id: "w1",
    agent_status: "blocked",
    agent: "claude",
  });
  await waitFor(() => registry.counts("runtime").blocked === 1);
  local.stop();
  await fake.close();
});

test("lifecycle events trigger an agent re-list (refresh)", async () => {
  const { fake, registry, local } = await setup();
  fake.agents = [
    { pane_id: "w1:p1", name: "claude", agent_status: "working" },
    { pane_id: "w1:p2", name: "copilot", agent_status: "idle" },
  ];
  fake.emitEvent("pane_agent_detected", { pane_id: "w1:p2", workspace_id: "w1", agent: "copilot" });
  await waitFor(() => registry.counts("runtime").idle === 1);
  assert.deepEqual(registry.counts("runtime"), { working: 1, blocked: 0, idle: 1 });
  local.stop();
  await fake.close();
});

test("a never-reachable endpoint's repeated failed connects never emit session_removed once the instance is up", async () => {
  const dir = tmpDir();
  const fake = new FakeHerdr(join(dir, "h.sock"));
  fake.agents = [{ pane_id: "w1:p1", name: "claude", agent_status: "working" }];
  await fake.listen();
  const registry = new Registry();
  const removedSessions: string[] = [];
  registry.on("session_removed", ({ session }: { session: string }) => {
    removedSessions.push(session);
  });
  const local = new LocalHerdr({
    registry,
    herdrVersion: "0.8.0-test",
    endpoints: [
      { session: "default", socketPath: fake.socketPath },
      { session: "dead", socketPath: join(dir, "no-listener.sock") },
    ],
    rescanMs: 20,
  });
  await local.start();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(local.sessions(), ["default"]);
  assert.ok(!removedSessions.includes("dead"));
  const result = (await local.request("default", "ping", {})) as { type: string };
  assert.equal(result.type, "pong");

  local.stop();
  await fake.close();
});

test("a legitimate oversized single-line response (>1MB) still resolves — the local cap is raised above the wire default", async () => {
  const { fake, local } = await setup();
  fake.handlers.set("big.read", () => ({ data: "x".repeat(2_000_000) }));
  const result = (await local.request("default", "big.read", {})) as { data: string };
  assert.equal(result.data.length, 2_000_000);
  local.stop();
  await fake.close();
});

test("a malformed line on the event channel retires just that session — a second session still answers", async () => {
  const dir = tmpDir();
  const fakeA = new FakeHerdr(join(dir, "a.sock"));
  fakeA.agents = [{ pane_id: "a:p1", name: "claude", agent_status: "working" }];
  await fakeA.listen();
  const fakeB = new FakeHerdr(join(dir, "b.sock"));
  fakeB.agents = [{ pane_id: "b:p1", name: "codex", agent_status: "idle" }];
  await fakeB.listen();

  const registry = new Registry();
  const removedSessions: string[] = [];
  registry.on("session_removed", ({ session }: { session: string }) => removedSessions.push(session));
  const local = new LocalHerdr({
    registry,
    herdrVersion: "0.8.0-test",
    endpoints: [
      { session: "a", socketPath: fakeA.socketPath },
      { session: "b", socketPath: fakeB.socketPath },
    ],
  });
  await local.start();
  assert.deepEqual(local.sessions().sort(), ["a", "b"]);

  fakeA.sendRaw("not json\n");
  await waitFor(() => local.sessions().sort().join(",") === "b");
  assert.ok(removedSessions.includes("a"));

  // The daemon is still alive: the untouched session still answers.
  const result = (await local.request("b", "agent.list", {})) as { agents: { pane_id: string }[] };
  assert.equal(result.agents[0].pane_id, "b:p1");

  local.stop();
  await fakeA.close();
  await fakeB.close();
});

test("stop() is idempotent", async () => {
  const { fake, local } = await setup();
  local.stop();
  assert.doesNotThrow(() => local.stop());
  assert.deepEqual(local.sessions(), []);
  await fake.close();
});

test("an unrecognized streamed status coerces to idle rather than corrupting counts", async () => {
  const { fake, registry, local } = await setup();
  fake.emitEvent("pane_agent_status_changed", {
    pane_id: "w1:p1",
    workspace_id: "w1",
    agent_status: "mystery",
    agent: "claude",
  });
  await waitFor(() => registry.counts("runtime").idle === 1);
  assert.deepEqual(registry.counts("runtime"), { working: 0, blocked: 0, idle: 1 });
  local.stop();
  await fake.close();
});
