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
