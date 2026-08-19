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
  fake.agents = [{ id: "a1", title: "claude", status: "working" }];
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

test("adapters map the assumed herdr shapes and reject junk", () => {
  assert.deepEqual(mapAgentList({ agents: [{ id: "a1", title: "t", status: "blocked" }] }), [
    { id: "a1", title: "t", status: "blocked" },
  ]);
  assert.deepEqual(mapAgentList({ nope: 1 }), []);
  assert.deepEqual(
    mapHerdrEvent({
      event: {
        type: "pane.agent_status_changed",
        agent: { id: "a1", title: "t", status: "idle" },
      },
    }),
    { agent: { id: "a1", title: "t", status: "idle" } },
  );
  assert.equal(mapHerdrEvent({ event: { type: "workspace.created" } }), undefined);
  assert.deepEqual(
    mapHerdrEvent({
      event: {
        type: "pane.agent_status_changed",
        agent: { id: "a1", title: "t", status: "mystery" },
      },
    }),
    { agent: { id: "a1", title: "t", status: "idle" } },
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
  fake.emitEvent({
    type: "pane.agent_status_changed",
    agent: { id: "a1", title: "claude", status: "blocked" },
  });
  await waitFor(() => registry.counts("runtime").blocked === 1);
  local.stop();
  await fake.close();
});

test("a never-reachable endpoint's repeated failed connects never emit session_removed once the instance is up", async () => {
  const dir = tmpDir();
  const fake = new FakeHerdr(join(dir, "h.sock"));
  fake.agents = [{ id: "a1", title: "claude", status: "working" }];
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
  // Let several rescan cycles retry (and fail) the dead endpoint after the
  // instance is already online in the registry — this is the window where
  // an unguarded onClose would fire a spurious session_removed.
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.deepEqual(local.sessions(), ["default"]);
  assert.ok(!removedSessions.includes("dead"));
  const result = (await local.request("default", "ping", {})) as { type: string };
  assert.equal(result.type, "pong");

  local.stop();
  await fake.close();
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
  fake.emitEvent({
    type: "pane.agent_status_changed",
    agent: { id: "a1", title: "claude", status: "mystery" },
  });
  await waitFor(() => registry.counts("runtime").idle === 1);
  const counts = registry.counts("runtime");
  assert.deepEqual(counts, { working: 0, blocked: 0, idle: 1 });
  local.stop();
  await fake.close();
});
