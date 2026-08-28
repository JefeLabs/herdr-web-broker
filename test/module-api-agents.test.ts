import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildApi } from "../src/module-api.js";
import { runBrokerMethod, type OpsDeps } from "../src/workspace-ops.js";
import { setup } from "./ops-harness.js";
import { scratchRepo } from "./util.js";

function apiFor(deps: OpsDeps, granted: string[]) {
  return buildApi({
    moduleId: "m1",
    granted: granted as never,
    deps,
    session: "default",
    instance: "runtime",
    events: { on() {} } as never,
    log: () => {},
    audit: { record: () => {} },
  }).api;
}

/** The fake herdr has no agent, so an ask never gets a real answer file.
 * Dropping one lets a held lock release so the test can finish. */
function answerAnyPending(cwd: string): void {
  const dir = join(cwd, ".herdr", "answers");
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) writeFileSync(join(dir, f), JSON.stringify({ answer: "done" }));
}

test("workspaces, agents and rpc are each absent when ungranted", async () => {
  const t = await setup();
  try {
    const api = apiFor(t.deps, []);
    assert.equal(api.workspaces, undefined);
    assert.equal(api.agents, undefined);
    assert.equal(api.rpc, undefined);
  } finally {
    await t.teardown();
  }
});

test("api.agents.ask CONTENDS with a CORE ask on the same pane — core first", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.deps.askPollMs = 20;
    t.fake.handlers.set("agent.prompt", () => ({ type: "ok" }));

    // Core takes the lock. The module's ask must be REFUSED, which proves
    // it takes the same lock rather than one of its own.
    const core = runBrokerMethod(t.deps, "default", "broker.agent.ask", {
      pane_id: "w1:p1",
      prompt: "core",
      timeout_ms: 3000,
    });
    await new Promise((r) => setTimeout(r, 40));

    const api = apiFor(t.deps, ["agents"]);
    await assert.rejects(
      () => api.agents!.ask("w1:p1", "module") as Promise<unknown>,
      /already in flight|pane_busy/,
    );

    answerAnyPending(cwd);
    await core.catch(() => undefined);
  } finally {
    await t.teardown();
  }
});

test("and the other ordering — module first, core second", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.deps.askPollMs = 20;
    t.fake.handlers.set("agent.prompt", () => ({ type: "ok" }));
    const api = apiFor(t.deps, ["agents"]);

    const modAsk = api.agents!.ask("w1:p1", "module", { timeoutMs: 3000 }) as Promise<unknown>;
    await new Promise((r) => setTimeout(r, 40));

    await assert.rejects(
      () => runBrokerMethod(t.deps, "default", "broker.agent.ask", { pane_id: "w1:p1", prompt: "core" }),
      /already in flight|pane_busy/,
    );

    answerAnyPending(cwd);
    await modAsk.catch(() => undefined);
  } finally {
    await t.teardown();
  }
});

test("api.agents.prompt steers without taking the lock — mid-ask steering is a feature", async () => {
  const t = await setup();
  try {
    t.deps.index.set("default", "w1", { cwd: scratchRepo() });
    let prompted = 0;
    t.fake.handlers.set("agent.prompt", () => {
      prompted++;
      return { type: "ok" };
    });
    const api = apiFor(t.deps, ["agents"]);
    await api.agents!.prompt("w1:p1", "steer");
    assert.equal(prompted, 1);
  } finally {
    await t.teardown();
  }
});

test("api.rpc reaches herdr", async () => {
  const t = await setup();
  try {
    const api = apiFor(t.deps, ["rpc"]);
    const r = (await api.rpc!("agent.list", {})) as { agents?: unknown[] };
    assert.ok(Array.isArray(r.agents));
  } finally {
    await t.teardown();
  }
});

test("api.workspaces.cwd reads the index; an unknown workspace is refused", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    const api = apiFor(t.deps, ["workspaces"]);
    assert.equal(await api.workspaces!.cwd("w1"), cwd);
    await assert.rejects(() => api.workspaces!.cwd("nope"), /no recorded cwd/);
  } finally {
    await t.teardown();
  }
});
