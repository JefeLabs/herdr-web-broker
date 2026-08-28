import test from "node:test";
import assert from "node:assert/strict";
import { BrokerEvents } from "../src/broker-events.js";
import { buildApi } from "../src/module-api.js";

function apiWith(granted: string[], events: BrokerEvents) {
  return buildApi({
    moduleId: "m1",
    granted: granted as never,
    deps: {} as never,
    session: "default",
    instance: "runtime",
    events,
    log: () => {},
    audit: { record: () => {} },
  }).api;
}

test("on is absent when events is ungranted", () => {
  assert.equal(apiWith([], new BrokerEvents()).on, undefined);
});

test("a granted module receives broker.* events", async () => {
  const bus = new BrokerEvents();
  const seen: unknown[] = [];
  apiWith(["events"], bus).on!("broker.agent.spawned", (e) => void seen.push(e));
  bus.emit("broker.agent.spawned", { pane_id: "w1:p1" });
  await bus.drain();
  assert.equal(seen.length, 1);
});

test("there is NO api.emit — modules consume, they do not publish", () => {
  const api = apiWith(["events"], new BrokerEvents()) as unknown as Record<string, unknown>;
  assert.equal(api.emit, undefined, "a message bus is not in abi 1");
  assert.equal(api.publish, undefined);
});

test("an unknown event name is refused at SUBSCRIBE time, not silently never fired", () => {
  const api = apiWith(["events"], new BrokerEvents());
  assert.throws(() => api.on!("broker.nope", () => {}), /unknown event/);
  assert.throws(() => api.on!("pane.exited", () => {}), /unknown event/);
});

test("two modules can subscribe to the same event independently", async () => {
  const bus = new BrokerEvents();
  const a: unknown[] = [];
  const b: unknown[] = [];
  apiWith(["events"], bus).on!("broker.exec.finished", (e) => void a.push(e));
  apiWith(["events"], bus).on!("broker.exec.finished", (e) => void b.push(e));
  bus.emit("broker.exec.finished", { exit_code: 0 });
  await bus.drain();
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});
