import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EnvRegistry } from "../src/env-registry.js";
import { BrokerError } from "../src/errors.js";
import { LocalHerdr } from "../src/local-attach.js";
import { ModelRegistry } from "../src/model-registry.js";
import { Registry } from "../src/registry.js";
import { WorkspaceIndex } from "../src/state.js";
import { isBrokerMethod, runBrokerMethod, type OpsDeps } from "../src/workspace-ops.js";
import { FakeHerdr, FakeHerdrError } from "./fake-herdr.js";
import { scratchRepo, sh, tmpDir } from "./util.js";

async function setup(): Promise<{ fake: FakeHerdr; deps: OpsDeps; teardown: () => Promise<void> }> {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  fake.agents = [{ pane_id: "w1:p1", name: "copilot", agent: "copilot", agent_status: "working" }];
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
    env: new EnvRegistry({ stateDir: tmpDir() }),
    models: new ModelRegistry(),
    askPollMs: 25,
    askGraceMs: 150,
    envSettleMs: 5,
    paneBusyDelayMs: 5,
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

test("spawn retries agent.start on agent_pane_busy until the cold pane's shell is ready", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w5:p1" } }));
    let starts = 0;
    t.fake.handlers.set("agent.start", () => {
      if (++starts < 3) throw new FakeHerdrError("agent_pane_busy", "agent target pane w5:p1 is not an available shell");
      return { type: "agent_started" };
    });
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.spawn", {
      kind: "copilot",
      cwd: scratchRepo(),
    })) as { workspace_id: string; pane_id: string };
    assert.equal(out.pane_id, "w5:p1");
    assert.equal(starts, 3, "agent.start retried on the SAME pane until herdr accepted it");
    const creates = t.fake.received.filter((r) => r.method === "workspace.create");
    assert.equal(creates.length, 1, "retries must not create more workspaces");
  } finally {
    await t.teardown();
  }
});

test("spawn gives up after bounded agent_pane_busy retries, still handing back the workspace for mode B", async () => {
  const t = await setup();
  t.deps.paneBusyRetries = 2;
  try {
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w6:p1" } }));
    let starts = 0;
    t.fake.handlers.set("agent.start", () => {
      starts++;
      throw new FakeHerdrError("agent_pane_busy", "agent target pane w6:p1 is not an available shell");
    });
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", cwd: scratchRepo() }),
      (e: BrokerError) =>
        e.code === "agent_pane_busy" && e.details.workspace_id === "w6" && e.details.pane_id === "w6:p1",
    );
    assert.equal(starts, 3, "initial attempt + paneBusyRetries, then give up");
  } finally {
    await t.teardown();
  }
});

test("broker.models.list: full catalog, kind filter, and config-extended entries", async () => {
  const t = await setup();
  t.deps.models = new ModelRegistry({ catalog: [{ kind: "aider", id: "deepseek-v3", context_window: 128000 }] });
  try {
    const all = (await runBrokerMethod(t.deps, "default", "broker.models.list", {})) as { models: { kind: string }[] };
    assert.ok(all.models.length > 3);
    const claude = (await runBrokerMethod(t.deps, "default", "broker.models.list", { kind: "claude" })) as {
      models: { kind: string; id: string; context_window?: number }[];
    };
    assert.ok(claude.models.every((m) => m.kind === "claude"));
    assert.ok(claude.models.every((m) => typeof m.context_window === "number"));
    const aider = (await runBrokerMethod(t.deps, "default", "broker.models.list", { kind: "aider" })) as {
      models: { id: string }[];
    };
    assert.equal(aider.models[0]?.id, "deepseek-v3");
  } finally {
    await t.teardown();
  }
});

test("broker.agent.model: renders the kind's switch command into the pane", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    // seeded agent: pane w1:p1, agent kind "copilot" (setup())
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.model", {
      pane_id: "w1:p1",
      model: "gpt-5",
    })) as { status: string; kind: string; command: string };
    assert.equal(out.status, "sent");
    assert.equal(out.kind, "copilot");
    assert.equal(out.command, "/model gpt-5");
    const sent = t.fake.received.find((r) => r.method === "pane.send_input");
    assert.ok(sent, "the switch travels as pane.send_input");
    assert.deepEqual(sent!.params, { pane_id: "w1:p1", text: "/model gpt-5", keys: ["Enter"] });
  } finally {
    await t.teardown();
  }
});

test("broker.agent.model: unknown model 404s and nothing is sent to the pane", async () => {
  const t = await setup();
  try {
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.model", { pane_id: "w1:p1", model: "gpt-99" }),
      (e: BrokerError) => e.code === "unknown_model",
    );
    assert.ok(!t.fake.received.some((r) => r.method === "pane.send_input"));
  } finally {
    await t.teardown();
  }
});

test("broker.agent.model: kind without a switch template answers model_switch_unsupported", async () => {
  const t = await setup();
  t.deps.models = new ModelRegistry({ catalog: [{ kind: "mystery", id: "m1" }] });
  t.fake.agents = [{ pane_id: "w1:p1", name: "mystery", agent: "mystery", agent_status: "idle" }];
  try {
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.model", { pane_id: "w1:p1", model: "m1" }),
      (e: BrokerError) => e.code === "model_switch_unsupported",
    );
  } finally {
    await t.teardown();
  }
});

test("broker.agent.model: no agent in the pane is a bad_request", async () => {
  const t = await setup();
  try {
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.model", { pane_id: "w9:p9", model: "gpt-5" }),
      (e: BrokerError) => e.code === "bad_request" && /no agent in pane/.test(e.message),
    );
  } finally {
    await t.teardown();
  }
});

test("spawn does not retry agent.start on non-busy errors", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w7:p1" } }));
    let starts = 0;
    t.fake.handlers.set("agent.start", () => {
      starts++;
      throw new FakeHerdrError("invalid_request", "unknown agent kind");
    });
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", cwd: scratchRepo() }),
      (e: BrokerError) => e.code === "invalid_request",
    );
    assert.equal(starts, 1, "a real error must fail fast, not burn the retry budget");
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

test("ask: a valid but oversized answer file is capped by the byte limit, not parsed in full (spec §6)", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    let file = "";
    t.fake.handlers.set("agent.prompt", (p) => {
      file = extractAnswerPath(cwd, (p as { text: string }).text);
      const pad = "x".repeat(900 * 1024);
      setTimeout(() => writeFileSync(file, JSON.stringify({ pad })), 50);
      return { type: "prompted" };
    });
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.ask", {
      pane_id: "w1:p1",
      prompt: "count things",
      timeout_ms: 5000,
    })) as { answer: null; raw: string; truncated: boolean; full_bytes: number; parse_error?: boolean };
    assert.equal(out.answer, null);
    assert.equal(out.truncated, true);
    assert.ok(out.full_bytes > 768 * 1024, `full_bytes was ${out.full_bytes}`);
    assert.ok(Buffer.byteLength(out.raw, "utf8") <= 768 * 1024);
    assert.equal(out.parse_error, undefined);
    assert.equal(existsSync(file), false, "the oversized answer file is deleted");
  } finally {
    await t.teardown();
  }
});

test("ask: an answers dir that escapes the workspace via a symlink is rejected (spec §2.5 step 5)", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    const outside = tmpDir();
    mkdirSync(join(cwd, ".herdr"), { recursive: true });
    symlinkSync(outside, join(cwd, ".herdr", "answers"));
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.ask", { pane_id: "w1:p1", prompt: "x", timeout_ms: 1000 }),
      (e: BrokerError) => e.code === "unknown_workspace",
    );
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

function armSpawnFake(fake: FakeHerdr): void {
  fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w9:p1" } }));
  fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
  fake.handlers.set("agent.start", () => ({ type: "ok" }));
}

test("spawn injects resolved env via drop file + send_input before agent.start", async () => {
  const t = await setup();
  try {
    armSpawnFake(t.fake);
    t.deps.env.set("COPILOT_GITHUB_TOKEN", "sekret-token", { kind: "copilot" });
    const cwd = scratchRepo();
    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", cwd });
    const order = t.fake.received.map((r) => r.method).filter((m) =>
      ["workspace.create", "pane.send_input", "agent.start"].includes(m));
    assert.deepEqual(order, ["workspace.create", "pane.send_input", "agent.start"]);
    const sent = t.fake.received.find((r) => r.method === "pane.send_input")!.params as { pane_id: string; text: string; keys: string[] };
    assert.equal(sent.pane_id, "w9:p1");
    assert.deepEqual(sent.keys, ["Enter"]);
    assert.match(sent.text, /^ \. .*envdrop.*\.sh; rm -f /);
    assert.ok(!sent.text.includes("sekret-token"), "value must never transit the PTY");
  } finally {
    await t.teardown();
  }
});

test("spawn skips injection entirely when nothing resolves", async () => {
  const t = await setup();
  try {
    armSpawnFake(t.fake);
    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", cwd: scratchRepo() });
    assert.ok(!t.fake.received.some((r) => r.method === "pane.send_input"));
  } finally {
    await t.teardown();
  }
});

test("spawn: failing hook aborts before any workspace is created", async () => {
  const t = await setup();
  try {
    armSpawnFake(t.fake);
    t.deps.env = new EnvRegistry({
      stateDir: tmpDir(),
      hooks: [{ name: "MUST_HAVE", kind: "copilot", command: [process.execPath, "-e", "process.exit(1)"] }],
    });
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", cwd: scratchRepo() }),
      (e: BrokerError) => e.code === "env_hook_failed",
    );
    assert.ok(!t.fake.received.some((r) => r.method === "workspace.create"));
  } finally {
    await t.teardown();
  }
});

test("spawn: send_input failure removes the drop file and fails the spawn", async () => {
  const t = await setup();
  try {
    armSpawnFake(t.fake);
    t.fake.handlers.delete("pane.send_input");
    const stateDir = tmpDir();
    t.deps.env = new EnvRegistry({ stateDir: stateDir });
    t.deps.env.set("TOKEN", "v", {});
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", cwd: scratchRepo() }),
      (e: BrokerError) => e.details.pane_id === "w9:p1",
    );
    assert.ok(!t.fake.received.some((r) => r.method === "agent.start"), "agent must not start unauthenticated");
    assert.deepEqual(readdirSync(join(stateDir, "envdrop")), [], "drop file cleaned up");
  } finally {
    await t.teardown();
  }
});
