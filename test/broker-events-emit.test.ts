import test from "node:test";
import assert from "node:assert/strict";
import { BrokerEvents } from "../src/broker-events.js";
import { runBrokerMethod } from "../src/workspace-ops.js";
import { setup } from "./ops-harness.js";
import { scratchRepo } from "./util.js";

test("a successful spawn emits broker.agent.spawned with the pane a handler needs", async () => {
  const t = await setup();
  try {
    const bus = new BrokerEvents();
    const seen: Record<string, unknown>[] = [];
    bus.on("broker.agent.spawned", (e) => void seen.push(e));
    t.deps.events = bus;
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));
    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", cwd: scratchRepo() });
    await bus.drain();
    assert.equal(seen.length, 1);
    assert.ok(seen[0].pane_id, "a handler cannot act without the pane id");
    assert.equal(seen[0].kind, "copilot");
  } finally {
    await t.teardown();
  }
});

test("broker.ask.unresponsive carries `evidence` — the field herdr cannot express", async () => {
  const t = await setup();
  try {
    const bus = new BrokerEvents();
    const seen: Record<string, unknown>[] = [];
    bus.on("broker.ask.unresponsive", (e) => void seen.push(e));
    t.deps.events = bus;
    t.deps.askStartGraceMs = 100;
    t.deps.askPollMs = 20;
    // A pane the REGISTRY does not know: registry status is undefined, so
    // sawWorking never becomes true and the start-grace path fires. This
    // mirrors the existing agent_unresponsive test in workspace-ops.
    t.deps.index.set("default", "w9", { cwd: scratchRepo() });
    t.fake.agents.push({ pane_id: "w9:p1", name: "deadish", agent: "copilot", agent_status: "idle" });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));

    await runBrokerMethod(t.deps, "default", "broker.agent.ask", {
      pane_id: "w9:p1",
      prompt: "x",
      timeout_ms: 5000,
    }).catch(() => undefined);
    await bus.drain();

    assert.equal(seen.length, 1);
    assert.ok(
      ["transcript", "status"].includes(String(seen[0].evidence)),
      "the whole point of this event is that it distinguishes the two tiers",
    );
  } finally {
    await t.teardown();
  }
});

test("broker.ask.completed fires AFTER the lock releases — a handler can ask again", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    const bus = new BrokerEvents();
    t.deps.events = bus;
    t.deps.askPollMs = 20;
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", () => ({ type: "ok" }));

    // The handler proves the lock is free by taking it: if completed were
    // emitted inside the try, this second ask would hit pane_busy.
    let secondAskRefused: string | undefined;
    bus.on("broker.ask.completed", async () => {
      try {
        await runBrokerMethod(t.deps, "default", "broker.agent.ask", {
          pane_id: "w1:p1",
          prompt: "again",
          timeout_ms: 200,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/already in flight|pane_busy/.test(msg)) secondAskRefused = msg;
      }
    });

    const first = runBrokerMethod(t.deps, "default", "broker.agent.ask", {
      pane_id: "w1:p1",
      prompt: "first",
      timeout_ms: 2000,
    });
    // Let the first ask land, then answer it so it completes.
    await new Promise((r) => setTimeout(r, 60));
    const { mkdirSync, readdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(cwd, ".herdr", "answers");
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) writeFileSync(join(dir, f), JSON.stringify({ answer: "ok" }));

    await first.catch(() => undefined);
    await bus.drain();

    assert.equal(secondAskRefused, undefined, "the lock was still held when broker.ask.completed fired");
  } finally {
    await t.teardown();
  }
});

test("emitting with no bus configured is a no-op — modules are optional", async () => {
  const t = await setup();
  try {
    assert.equal(t.deps.events, undefined);
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));
    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", cwd: scratchRepo() });
  } finally {
    await t.teardown();
  }
});
