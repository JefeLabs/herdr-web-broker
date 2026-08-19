import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError } from "../src/errors.js";
import { LocalHerdr } from "../src/local-attach.js";
import { Registry } from "../src/registry.js";
import { WorkspaceIndex } from "../src/state.js";
import { isBrokerMethod, runBrokerMethod, type OpsDeps } from "../src/workspace-ops.js";
import { FakeHerdr } from "./fake-herdr.js";
import { scratchRepo, sh, tmpDir } from "./util.js";

async function setup(): Promise<{ fake: FakeHerdr; deps: OpsDeps; teardown: () => Promise<void> }> {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  fake.agents = [{ pane_id: "w1:p1", name: "copilot", agent_status: "working" }];
  await fake.listen();
  const registry = new Registry();
  const local = new LocalHerdr({
    registry,
    herdrVersion: "0.8.0-test",
    endpoints: [{ session: "default", socketPath: fake.socketPath }],
  });
  await local.start();
  // Mirror daemon.ts: the registry entry for "runtime" must exist or
  // applyAgentStatus is a silent no-op (the ask early-exit test drives
  // pane status through the registry exactly the way SessionEvents does).
  registry.replaceSnapshot("runtime", await local.snapshot());
  const deps: OpsDeps = {
    local,
    registry,
    index: new WorkspaceIndex(tmpDir()),
    askPollMs: 25,
    askGraceMs: 150,
  };
  return {
    fake,
    deps,
    teardown: async () => {
      local.stop();
      await fake.close();
    },
  };
}

test("isBrokerMethod matches only the broker.* namespace", () => {
  assert.equal(isBrokerMethod("broker.workspace.list"), true);
  assert.equal(isBrokerMethod("agent.list"), false);
  assert.equal(isBrokerMethod("brokerx.list"), false);
});

test("runBrokerMethod: unknown session and unknown broker method fail cleanly", async () => {
  const t = await setup();
  try {
    await assert.rejects(
      runBrokerMethod(t.deps, "ghost", "broker.workspace.list", {}),
      (e: BrokerError) => e.code === "unknown_session",
    );
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.nope", {}),
      (e: BrokerError) => e.code === "bad_request",
    );
  } finally {
    await t.teardown();
  }
});

test("broker.workspace.list: herdr agents grouped by workspace; index supplies cwd; repos discovered", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd, label: "demo" });
    const out = (await runBrokerMethod(t.deps, "default", "broker.workspace.list", {})) as {
      workspaces: { workspace_id: string; cwd: string | null; label?: string; agents: unknown[]; repos: { path: string }[] }[];
    };
    assert.equal(out.workspaces.length, 1);
    const w = out.workspaces[0];
    assert.equal(w.workspace_id, "w1");
    assert.equal(w.cwd, cwd);
    assert.equal(w.label, "demo");
    assert.deepEqual(w.agents, [{ agent: "copilot", pane_id: "w1:p1", status: "working" }]);
    assert.deepEqual(w.repos.map((r) => r.path), ["."]);
  } finally {
    await t.teardown();
  }
});

test("broker.workspace.list: a workspace with no recorded cwd lists as cwd:null, repos:[]", async () => {
  const t = await setup();
  try {
    const out = (await runBrokerMethod(t.deps, "default", "broker.workspace.list", {})) as {
      workspaces: { workspace_id: string; cwd: string | null; repos: unknown[] }[];
    };
    assert.deepEqual(out.workspaces.map((w) => [w.workspace_id, w.cwd, w.repos]), [["w1", null, []]]);
  } finally {
    await t.teardown();
  }
});

test("broker.repo.tree and broker.repo.diff resolve through the index; unknown cwd is unknown_workspace", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    writeFileSync(join(cwd, "a.txt"), "two\n");
    t.deps.index.set("default", "w1", { cwd });
    const tree = (await runBrokerMethod(t.deps, "default", "broker.repo.tree", { workspace_id: "w1", repo: "-" })) as {
      tree: { children: { name: string }[] };
    };
    assert.deepEqual(tree.tree.children.map((c) => c.name), ["a.txt"]);
    const diff = (await runBrokerMethod(t.deps, "default", "broker.repo.diff", { workspace_id: "w1", repo: "-" })) as {
      branch: string; diff: string;
    };
    assert.equal(diff.branch, "main");
    assert.match(diff.diff, /\+two/);
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.repo.tree", { workspace_id: "w9", repo: "-" }),
      (e: BrokerError) => e.code === "unknown_workspace",
    );
  } finally {
    await t.teardown();
  }
});

test("spawn mode A: workspace.create + agent.start, cwd validated and recorded in the index", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.spawn", {
      kind: "copilot",
      cwd,
      label: "demo",
      args: ["--model", "gpt-5"],
    })) as { workspace_id: string; pane_id: string; agent: string; status: string };
    assert.deepEqual(out, { workspace_id: "w2", pane_id: "w2:p1", agent: "copilot", status: "idle" });
    assert.deepEqual(t.deps.index.get("default", "w2"), { cwd, label: "demo" });
    const started = t.fake.received.find((r) => r.method === "agent.start");
    assert.deepEqual(started?.params, { name: "copilot", kind: "copilot", pane_id: "w2:p1", args: ["--model", "gpt-5"] });
    const created = t.fake.received.find((r) => r.method === "workspace.create");
    assert.deepEqual(created?.params, { cwd, label: "demo" });
  } finally {
    await t.teardown();
  }
});

test("spawn validation: kind required; exactly one of cwd/workspace_id; cwd must be an absolute existing dir", async () => {
  const t = await setup();
  try {
    for (const body of [
      { cwd: "/tmp" },                                   // no kind
      { kind: "copilot" },                               // neither cwd nor workspace_id
      { kind: "copilot", cwd: "/x", workspace_id: "w1" },// both
      { kind: "copilot", cwd: "relative/path" },         // not absolute
      { kind: "copilot", cwd: join(tmpDir(), "nope") },  // does not exist
    ]) {
      await assert.rejects(
        runBrokerMethod(t.deps, "default", "broker.agent.spawn", body),
        (e: BrokerError) => e.code === "bad_request",
        JSON.stringify(body),
      );
    }
  } finally {
    await t.teardown();
  }
});

test("spawn mode B: joins an existing workspace's team — same cwd, inherited label (spec §8.2 fallback)", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd, label: "team-x" });
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w3:p1" } }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.spawn", {
      kind: "copilot",
      workspace_id: "w1",
    })) as { workspace_id: string };
    assert.equal(out.workspace_id, "w3");
    assert.deepEqual(t.deps.index.get("default", "w3"), { cwd, label: "team-x" });
    const created = t.fake.received.find((r) => r.method === "workspace.create");
    assert.deepEqual(created?.params, { cwd, label: "team-x" });
  } finally {
    await t.teardown();
  }
});

test("spawn partial failure: agent.start error carries the orphaned workspace_id (spec §2.1)", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w4:p1" } }));
    // no agent.start handler → FakeHerdr answers a not_found error
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", cwd: scratchRepo() }),
      (e: BrokerError) => e.details.workspace_id === "w4" && e.details.pane_id === "w4:p1",
    );
    assert.ok(t.deps.index.get("default", "w4"), "the orphaned workspace stays in the index for a mode-B retry");
  } finally {
    await t.teardown();
  }
});

function extractAnswerPath(cwd: string, text: unknown): string {
  const m = /\.herdr\/answers\/([a-f0-9]{16})\.json/.exec(String(text));
  assert.ok(m, "prompt text names an answer file");
  return join(cwd, ".herdr", "answers", `${m![1]}.json`);
}

test("ask: agent writes the answer file; broker returns parsed JSON and deletes it", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", (p) => {
      const file = extractAnswerPath(cwd, (p as { text: string }).text);
      setTimeout(() => writeFileSync(file, '{"ok":true,"n":2}'), 50);
      return { type: "prompted" };
    });
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.ask", {
      pane_id: "w1:p1",
      prompt: "count things",
      timeout_ms: 5000,
    })) as { answer: unknown };
    assert.deepEqual(out.answer, { ok: true, n: 2 });
    const prompted = t.fake.received.find((r) => r.method === "agent.prompt");
    assert.equal((prompted?.params as { target: string }).target, "copilot");
  } finally {
    await t.teardown();
  }
});

test("ask: invalid JSON in the answer file surfaces as parse_error with capped raw", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", (p) => {
      writeFileSync(extractAnswerPath(cwd, (p as { text: string }).text), "not json");
      return { type: "prompted" };
    });
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.ask", {
      pane_id: "w1:p1",
      prompt: "x",
      timeout_ms: 1000,
    })) as { answer: null; raw: string; parse_error: boolean };
    assert.equal(out.parse_error, true);
    assert.equal(out.raw, "not json");
    assert.equal(out.answer, null);
  } finally {
    await t.teardown();
  }
});

test("ask: no answer file within timeout_ms is upstream_timeout", async () => {
  const t = await setup();
  try {
    t.deps.index.set("default", "w1", { cwd: scratchRepo() });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.ask", { pane_id: "w1:p1", prompt: "x", timeout_ms: 1000 }),
      (e: BrokerError) => e.code === "upstream_timeout",
    );
  } finally {
    await t.teardown();
  }
});

test("ask: agent that finishes without writing exits early via the status grace, not the full budget", async () => {
  const t = await setup();
  try {
    t.deps.index.set("default", "w1", { cwd: scratchRepo() });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    const started = Date.now();
    const pending = assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.ask", { pane_id: "w1:p1", prompt: "x", timeout_ms: 60_000 }),
      (e: BrokerError) => e.code === "upstream_timeout",
    );
    // drive the status through the registry the way SessionEvents would
    t.deps.registry.applyAgentStatus("runtime", "default", { id: "w1:p1", title: "copilot", status: "working" });
    await new Promise((r) => setTimeout(r, 100));
    t.deps.registry.applyAgentStatus("runtime", "default", { id: "w1:p1", title: "copilot", status: "idle" });
    await pending;
    assert.ok(Date.now() - started < 10_000, "returned early, not after the 60s budget");
  } finally {
    await t.teardown();
  }
});

test("ask: unknown cwd is unknown_workspace; unknown pane is bad_request", async () => {
  const t = await setup();
  try {
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.ask", { pane_id: "w9:p1", prompt: "x" }),
      (e: BrokerError) => e.code === "unknown_workspace",
    );
    t.deps.index.set("default", "w1", { cwd: scratchRepo() });
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.ask", { pane_id: "w1:p9", prompt: "x" }),
      (e: BrokerError) => e.code === "bad_request",
    );
  } finally {
    await t.teardown();
  }
});

test("ask: a late-landing valid answer is still parsed after the poll loop exits (not discarded as parse_error)", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.deps.askPollMs = 600;
    t.fake.handlers.set("agent.prompt", (p) => {
      const file = extractAnswerPath(cwd, (p as { text: string }).text);
      setTimeout(() => writeFileSync(file, '{"late":true}'), 800);
      return { type: "prompted" };
    });
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.ask", {
      pane_id: "w1:p1",
      prompt: "x",
      timeout_ms: 1000,
    })) as { answer: unknown; parse_error?: boolean };
    assert.deepEqual(out.answer, { late: true });
    assert.equal(out.parse_error, undefined);
  } finally {
    await t.teardown();
  }
});

test("ask: a blocked agent pauses the grace countdown instead of triggering an early exit", async () => {
  const t = await setup();
  try {
    t.deps.index.set("default", "w1", { cwd: scratchRepo() });
    t.deps.askGraceMs = 100;
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    const started = Date.now();
    const pending = assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.ask", { pane_id: "w1:p1", prompt: "x", timeout_ms: 1000 }),
      (e: BrokerError) => e.code === "upstream_timeout",
    );
    setTimeout(
      () => t.deps.registry.applyAgentStatus("runtime", "default", { id: "w1:p1", title: "copilot", status: "working" }),
      50,
    );
    setTimeout(
      () => t.deps.registry.applyAgentStatus("runtime", "default", { id: "w1:p1", title: "copilot", status: "blocked" }),
      150,
    );
    await pending;
    assert.ok(Date.now() - started >= 900, "waited out the full budget instead of grace-exiting while blocked");
  } finally {
    await t.teardown();
  }
});
