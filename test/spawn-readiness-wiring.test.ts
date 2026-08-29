import test from "node:test";
import assert from "node:assert/strict";
import { runBrokerMethod } from "../src/workspace-ops.js";
import { setup } from "./ops-harness.js";
import { scratchRepo } from "./util.js";

/** Spawn readiness wired into spawn() — spec 2026-08-28.
 *
 * spawn-readiness.test.ts covers the policy in isolation. These drive it
 * through the real `broker.agent.spawn` against FakeHerdr, because the wiring
 * is where the interesting regressions live: a sentinel that never reaches the
 * pane, an env line that loses its `source`, or a readiness failure that stops
 * a spawn that used to succeed.
 *
 * The shared harness sets `readinessTimeoutMs: 0`, so each test here opts back
 * in explicitly. */

const SENTINEL = /printf '__herdr_ready_[0-9a-f]{12}__/;

test("spawn sends a readiness sentinel before agent.start", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.readinessTimeoutMs = 2000;
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    t.fake.handlers.set("pane.wait_for_output", () => ({ matched_line: "__herdr_ready__" }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));

    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "codex", cwd });

    const methods = t.fake.received.map((r) => r.method);
    const sent = t.fake.received.find((r) => r.method === "pane.send_input");
    assert.match(String((sent?.params as { text?: string })?.text), SENTINEL);
    assert.ok(
      methods.indexOf("pane.wait_for_output") < methods.indexOf("agent.start"),
      `readiness must be proven BEFORE agent.start: ${methods.join(" → ")}`,
    );
  } finally {
    await t.teardown();
  }
});

test("a sentinel that never echoes does not block the spawn", async () => {
  // The floor is the agent_pane_busy retry; readiness is best-effort. A
  // readiness check that can fail a spawn is a new failure mode, which is
  // exactly what this design refuses to introduce.
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.readinessTimeoutMs = 50;
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    t.fake.handlers.set("pane.wait_for_output", () => {
      throw new Error("timed out");
    });
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));

    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.spawn", {
      kind: "codex",
      cwd,
    })) as { pane_id?: string };

    assert.equal(out.pane_id, "w2:p1", "the spawn still succeeds");
    assert.ok(t.fake.received.some((r) => r.method === "agent.start"), "agent.start is still reached");
  } finally {
    await t.teardown();
  }
});

test("the env drop line carries source, delete AND sentinel, in that order", async () => {
  // One round trip does both jobs. A regression that kept the sentinel but
  // dropped the `.` would leave the agent with no env and still pass every
  // readiness assertion, so the ORDER is asserted, not just the presence.
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.readinessTimeoutMs = 2000;
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    t.fake.handlers.set("pane.wait_for_output", () => ({ matched_line: "ready" }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));

    // claude's prepare block always yields CLAUDE_CONFIG_DIR, so this kind
    // always takes the drop-file path.
    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "claude", cwd });

    const sends = t.fake.received.filter((r) => r.method === "pane.send_input");
    assert.equal(sends.length, 1, "env + readiness share ONE send, not two");
    const text = String((sends[0].params as { text?: string }).text);
    assert.match(text, /^ \. \S+; rm -f \S+; printf '__herdr_ready_/, `composed line was: ${text}`);
    assert.ok(text.indexOf("rm -f") < text.indexOf("printf"), "sentinel must come last");
  } finally {
    await t.teardown();
  }
});

test("mode B (pane.split) gets a sentinel too — it never settled before", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.readinessTimeoutMs = 2000;
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w3:p1" } }));
    t.fake.handlers.set("pane.split", () => ({ pane: { pane_id: "w3:p2" } }));
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    t.fake.handlers.set("pane.wait_for_output", () => ({ matched_line: "ready" }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));

    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "codex", cwd });
    t.fake.received.length = 0;
    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", {
      kind: "codex",
      workspace_id: "w3",
    });

    const sent = t.fake.received.find((r) => r.method === "pane.send_input");
    assert.ok(sent, "mode B previously sent nothing into the split pane");
    assert.match(String((sent.params as { text?: string }).text), SENTINEL);
    assert.equal(
      String((sent.params as { pane_id?: string }).pane_id),
      "w3:p2",
      "the sentinel goes to the NEW pane, not the workspace root",
    );
  } finally {
    await t.teardown();
  }
});

test("two spawns into one workspace use different markers", async () => {
  // A reused pane can hold the previous sentinel. Identical markers would let
  // spawn #2 match spawn #1's stale echo and call a cold shell ready.
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.readinessTimeoutMs = 2000;
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w4:p1" } }));
    t.fake.handlers.set("pane.split", () => ({ pane: { pane_id: "w4:p2" } }));
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    t.fake.handlers.set("pane.wait_for_output", () => ({ matched_line: "ready" }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));

    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "codex", cwd });
    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "codex", workspace_id: "w4" });

    const markers = t.fake.received
      .filter((r) => r.method === "pane.send_input")
      .map((r) => /__herdr_ready_([0-9a-f]{12})__/.exec(String((r.params as { text?: string }).text))?.[1]);
    assert.equal(markers.length, 2);
    assert.notEqual(markers[0], markers[1]);
  } finally {
    await t.teardown();
  }
});
