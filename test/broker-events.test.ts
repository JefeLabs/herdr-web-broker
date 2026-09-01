import test from "node:test";
import assert from "node:assert/strict";
import { BrokerEvents, BROKER_EVENTS } from "../src/broker-events.js";

test("the seven broker events are the ones herdr cannot know", () => {
  assert.deepEqual(
    [...BROKER_EVENTS],
    [
      "broker.agent.spawned",
      "broker.agent.spawn_failed",
      "broker.ask.completed",
      "broker.ask.unresponsive",
      "broker.repo.pushed",
      "broker.exec.finished",
      // Roadmap 31(f). The odd one out, and deliberately so: herdr DOES know
      // it reaped a workspace and says so on its own event channel. What
      // herdr cannot know is whether that workspace was one the broker had a
      // row for — `indexed` is the broker's own adopt/orphan judgement
      // attached to herdr's fact, which is why it belongs on this list.
      "broker.workspace.reaped",
    ],
  );
});

test("emit reaches every handler registered for that name, and no others", async () => {
  const bus = new BrokerEvents();
  const spawned: unknown[] = [];
  const asked: unknown[] = [];
  bus.on("broker.agent.spawned", (e) => void spawned.push(e));
  bus.on("broker.ask.completed", (e) => void asked.push(e));
  bus.emit("broker.agent.spawned", { pane_id: "w1:p1" });
  await bus.drain();
  assert.equal(spawned.length, 1);
  assert.equal(asked.length, 0);
});

test("the payload carries name and an ISO timestamp the handler did not have to add", async () => {
  const bus = new BrokerEvents();
  let got: Record<string, unknown> | undefined;
  bus.on("broker.exec.finished", (e) => void (got = e));
  bus.emit("broker.exec.finished", { exit_code: 1 });
  await bus.drain();
  assert.equal(got?.name, "broker.exec.finished");
  assert.equal(got?.exit_code, 1);
  assert.match(String(got?.at), /^\d{4}-\d{2}-\d{2}T/);
});

test("a THROWING handler does not stop its siblings or the emitter", async () => {
  const bus = new BrokerEvents();
  const reached: string[] = [];
  bus.on("broker.repo.pushed", () => {
    throw new Error("boom");
  });
  bus.on("broker.repo.pushed", () => void reached.push("second"));
  bus.emit("broker.repo.pushed", {});
  await bus.drain();
  assert.deepEqual(reached, ["second"], "a bad handler must not silence a good one");
  assert.equal(bus.counts().errors, 1);
});

test("a REJECTING async handler is caught too", async () => {
  const bus = new BrokerEvents();
  bus.on("broker.ask.unresponsive", async () => {
    throw new Error("async boom");
  });
  bus.emit("broker.ask.unresponsive", {});
  await bus.drain();
  assert.equal(bus.counts().errors, 1);
});

test("emit with no handlers is a no-op, not an error", async () => {
  const bus = new BrokerEvents();
  bus.emit("broker.agent.spawn_failed", { code: "x" });
  await bus.drain();
  assert.equal(bus.counts().errors, 0);
});

test("emit never awaits — a slow handler cannot delay the caller", async () => {
  const bus = new BrokerEvents();
  let resolved = false;
  bus.on("broker.agent.spawned", async () => {
    await new Promise((r) => setTimeout(r, 50));
    resolved = true;
  });
  bus.emit("broker.agent.spawned", {});
  assert.equal(resolved, false, "emit returned before the handler finished — that is the contract");
  await bus.drain();
  assert.equal(resolved, true);
});
