import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EnvRegistry } from "../src/env-registry.js";
import { BrokerError } from "../src/errors.js";
import { ModelRegistry } from "../src/model-registry.js";
import { CliProfiles } from "../src/cli-profiles.js";
import { isBrokerMethod, runBrokerMethod } from "../src/workspace-ops.js";
import { FakeHerdr, FakeHerdrError } from "./fake-herdr.js";
import { setup } from "./ops-harness.js";
import { scratchRepo, sh, tmpDir } from "./util.js";

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

test("spawn: a pinnable kind (claude) appends --session-id after the caller's own args", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));
    // claude's prepare block always yields CLAUDE_CONFIG_DIR, so spawn's
    // env-injection path (drop file + send_input) runs for this kind.
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", {
      kind: "claude",
      cwd,
      args: ["--model", "opus"],
    });
    const started = t.fake.received.find((r) => r.method === "agent.start");
    const args = (started?.params as { args: string[] }).args;
    assert.deepEqual(args.slice(0, 2), ["--model", "opus"], "the caller's own args stay first, untouched");
    assert.equal(args[2], "--session-id");
    assert.match(args[3], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a real uuid");
  } finally {
    await t.teardown();
  }
});

test("spawn: the pinned id sent to agent.start is the same id recorded in AgentIndex", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));
    // claude's prepare block always yields CLAUDE_CONFIG_DIR, so spawn's
    // env-injection path (drop file + send_input) runs for this kind.
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "claude", cwd });
    const started = t.fake.received.find((r) => r.method === "agent.start");
    const sentId = (started?.params as { args: string[] }).args[1];
    const meta = t.deps.agents.get("default", "w2:p1");
    assert.equal(meta?.kind, "claude");
    assert.equal(typeof meta?.startedAt, "number");
    assert.equal(meta?.sessionId, sentId, "the recorded id is the id actually sent, not merely a uuid");
  } finally {
    await t.teardown();
  }
});

test("spawn: an unpinnable kind (copilot) records meta with the sessionId key omitted entirely", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));
    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", cwd });
    const started = t.fake.received.find((r) => r.method === "agent.start");
    assert.equal((started?.params as { args?: string[] }).args, undefined, "no args were injected");
    const meta = t.deps.agents.get("default", "w2:p1");
    assert.equal(meta?.kind, "copilot");
    assert.equal(typeof meta?.startedAt, "number");
    assert.equal(meta !== undefined && "sessionId" in meta, false, "the key is omitted, not merely falsy");
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

test("spawn mode B: pane.split joins the EXISTING workspace — no new workspace, no leak", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd, label: "team-x" });
    t.fake.handlers.set("pane.split", () => ({ type: "pane_info", pane: { pane_id: "w1:p2" } }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.spawn", {
      kind: "copilot",
      workspace_id: "w1",
    })) as { workspace_id: string; pane_id: string };
    assert.equal(out.workspace_id, "w1", "the agent joined the SAME workspace");
    assert.equal(out.pane_id, "w1:p2");
    const split = t.fake.received.find((r) => r.method === "pane.split");
    assert.deepEqual(split?.params, { workspace_id: "w1", direction: "right", cwd });
    assert.equal(t.fake.received.some((r) => r.method === "workspace.create"), false, "no new workspace created");
    const started = t.fake.received.find((r) => r.method === "agent.start");
    assert.equal((started?.params as { pane_id: string }).pane_id, "w1:p2");
  } finally {
    await t.teardown();
  }
});

test("spawn mode B: env-registry values ride pane.split's native env map — no drop file", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.deps.env.set("COPILOT_GITHUB_TOKEN", "sekret", { kind: "copilot" });
    t.fake.handlers.set("pane.split", () => ({ type: "pane_info", pane: { pane_id: "w1:p2" } }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));
    await runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", workspace_id: "w1" });
    const split = t.fake.received.find((r) => r.method === "pane.split");
    assert.deepEqual((split?.params as { env: Record<string, string> }).env, { COPILOT_GITHUB_TOKEN: "sekret" });
    // native injection — nothing typed into the pane, no file to source
    assert.equal(t.fake.received.some((r) => r.method === "pane.send_input"), false);
  } finally {
    await t.teardown();
  }
});

test("spawn: agent_name_taken on the DEFAULT name retries with a pane-unique name; explicit names fail through", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("pane.split", () => ({ type: "pane_info", pane: { pane_id: "w1:p2" } }));
    const startNames: string[] = [];
    t.fake.handlers.set("agent.start", (p) => {
      const name = String((p as { name: string }).name);
      startNames.push(name);
      if (name === "copilot") throw new FakeHerdrError("agent_name_taken", "agent name copilot is already used");
      return { type: "agent_started" };
    });
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.spawn", {
      kind: "copilot",
      workspace_id: "w1",
    })) as { agent: string; pane_id: string };
    assert.deepEqual(startNames, ["copilot", "copilot-w1p2"], "one retry with a pane-unique default");
    assert.equal(out.agent, "copilot-w1p2", "the response carries the name actually used");

    // an EXPLICIT name is the caller's choice — collision is their error
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", workspace_id: "w1", name: "copilot" }),
      (e: BrokerError) => e.code === "agent_name_taken",
    );
  } finally {
    await t.teardown();
  }
});

test("spawn mode C: worktree {branch, base} creates an isolated checkout and starts the agent there", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.fake.handlers.set("worktree.create", () => ({
      type: "worktree_created",
      workspace: { workspace_id: "w6" },
      root_pane: { pane_id: "w6:p1" },
      worktree: { branch: "feat-x", path: "/tmp/wt/feat-x", is_linked_worktree: true },
    }));
    t.fake.handlers.set("agent.start", () => ({ type: "agent_started" }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.spawn", {
      kind: "copilot",
      cwd,
      worktree: { branch: "feat-x", base: "main" },
    })) as { workspace_id: string; pane_id: string; worktree?: { branch: string; path: string } };
    assert.equal(out.workspace_id, "w6");
    assert.equal(out.pane_id, "w6:p1");
    assert.deepEqual(out.worktree, { branch: "feat-x", path: "/tmp/wt/feat-x" });
    const created = t.fake.received.find((r) => r.method === "worktree.create");
    assert.deepEqual(created?.params, { cwd, branch: "feat-x", base: "main" });
    // the index records the CHECKOUT as the workspace cwd, so repo/git/context
    // endpoints operate inside the worktree
    assert.equal(t.deps.index.get("default", "w6")?.cwd, "/tmp/wt/feat-x");

    // worktree needs mode A (cwd = the repo); branch is required
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.spawn", {
        kind: "copilot",
        workspace_id: "w1",
        worktree: { branch: "x" },
      }),
      (e: BrokerError) => e.code === "bad_request",
    );
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", cwd, worktree: {} }),
      (e: BrokerError) => e.code === "bad_request",
    );
  } finally {
    await t.teardown();
  }
});

test("broker.worktree.list: inventories the repo's worktrees via the workspace's cwd", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("worktree.list", () => ({
      type: "worktree_list",
      source: { repo_root: cwd, source_workspace_id: "w1" },
      worktrees: [
        { path: cwd, branch: "main", is_linked_worktree: false, open_workspace_id: "w1" },
        { path: "/tmp/wt/feat-x", branch: "feat-x", is_linked_worktree: true, open_workspace_id: "w6" },
      ],
    }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.worktree.list", { workspace_id: "w1" })) as {
      workspace_id: string;
      worktrees: { branch: string }[];
    };
    assert.equal(out.workspace_id, "w1");
    assert.deepEqual(out.worktrees.map((w) => w.branch), ["main", "feat-x"]);
    const sent = t.fake.received.find((r) => r.method === "worktree.list");
    assert.deepEqual(sent?.params, { cwd });
  } finally {
    await t.teardown();
  }
});

test("broker.worktree.remove: deletes the checkout, keeps the branch, forgets the index entry", async () => {
  const t = await setup();
  try {
    t.deps.index.set("default", "w6", { cwd: "/tmp/wt/feat-x" });
    t.fake.handlers.set("worktree.remove", () => ({
      type: "worktree_removed",
      workspace_id: "w6",
      path: "/tmp/wt/feat-x",
      forced: false,
    }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.worktree.remove", {
      workspace_id: "w6",
    })) as { workspace_id: string; removed: boolean; path: string };
    assert.deepEqual(out, { workspace_id: "w6", removed: true, path: "/tmp/wt/feat-x" });
    const sent = t.fake.received.find((r) => r.method === "worktree.remove");
    assert.deepEqual(sent?.params, { workspace_id: "w6" });
    assert.equal(t.deps.index.get("default", "w6"), undefined);
  } finally {
    await t.teardown();
  }
});

test("broker.agent.wait: status wait defaults to needs-me-or-done; timeout is a 200, not an error", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("agent.wait", () => ({
      type: "agent_info",
      agent: { pane_id: "w1:p1", name: "copilot", agent: "copilot", agent_status: "blocked" },
    }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.wait", { pane_id: "w1:p1" })) as {
      waited: boolean;
      status: string;
      raw_status: string;
      pane_id: string;
    };
    assert.deepEqual(out, {
      waited: true,
      status: "blocked",
      raw_status: "blocked",
      evidence: "status",
      pane_id: "w1:p1",
    });
    const sent = t.fake.received.find((r) => r.method === "agent.wait");
    assert.deepEqual(sent?.params, { target: "copilot", until: ["idle", "blocked", "done"], timeout_ms: 30_000 });

    // herdr's timeout becomes a branchable 200-shape, mirroring screen's unchanged
    t.fake.handlers.set("agent.wait", () => {
      throw new FakeHerdrError("timeout", "timed out waiting for agent status");
    });
    const timedOut = (await runBrokerMethod(t.deps, "default", "broker.agent.wait", {
      pane_id: "w1:p1",
      until: ["done"],
      timeout_ms: 2_000,
    })) as { waited: boolean; timed_out?: boolean };
    assert.deepEqual(timedOut, { waited: false, timed_out: true, pane_id: "w1:p1" });

    // until values are validated; until+match together is a contract error
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.wait", { pane_id: "w1:p1", until: ["sleeping"] }),
      (e: BrokerError) => e.code === "bad_request",
    );
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.wait", { pane_id: "w1:p1", until: ["idle"], match: "x" }),
      (e: BrokerError) => e.code === "bad_request",
    );
  } finally {
    await t.teardown();
  }
});

// The claude builtin's terminal vocabulary, reused so these profile
// overrides parse exactly like the real claude profile — only `template`
// changes, to an absolute tmp path with no {home} placeholder so the tier
// is reachable through the real askInner/waitAgent call sites without
// touching the actual OS home directory.
const CLAUDE_TERMINAL = { done: ["end_turn", "stop_sequence", "max_tokens", "refusal"], blocked: ["tool_use"], running: [] };

test("broker.agent.wait: a transcript that proves completion overrides herdr's raw status (evidence: transcript)", async () => {
  const t = await setup();
  try {
    const dir = join(tmpDir(), "claude-transcripts");
    mkdirSync(dir, { recursive: true });
    t.deps.profiles = new CliProfiles({
      profiles: [
        {
          kind: "claude",
          pin: { flag: "--session-id" },
          transcript: { via: "path", template: join(dir, "{sessionId}.jsonl") },
          terminal: CLAUDE_TERMINAL,
        },
      ],
    });
    t.fake.agents.push({ pane_id: "w7:p1", name: "claude-a", agent: "claude", agent_status: "working" });
    // waitAgent's cwd comes from the index (never touched on disk for this
    // via, but readTurnState is only reached when it resolves at all).
    t.deps.index.set("default", "w7", { cwd: "/work/proj" });
    t.deps.agents.set("default", "w7:p1", { sessionId: "sid-w7", kind: "claude", startedAt: 0 });
    // Timestamp far in the future so it's unambiguously fresh relative to
    // whenever this test actually runs — no clock-skew flakiness.
    writeFileSync(
      join(dir, "sid-w7.jsonl"),
      '{"type":"assistant","timestamp":"2030-01-01T00:00:00.000Z","message":{"role":"assistant","stop_reason":"end_turn"}}\n',
    );
    // herdr itself still reports "working" — the transcript is the proof
    t.fake.handlers.set("agent.wait", () => ({
      type: "agent_info",
      agent: { pane_id: "w7:p1", name: "claude-a", agent: "claude", agent_status: "working" },
    }));
    const out = await runBrokerMethod(t.deps, "default", "broker.agent.wait", { pane_id: "w7:p1", until: ["idle"] });
    assert.deepEqual(out, {
      waited: true,
      status: "idle",
      raw_status: "done",
      evidence: "transcript",
      pane_id: "w7:p1",
    });
  } finally {
    await t.teardown();
  }
});

test("broker.agent.wait: a transcript record from before THIS wait began is not evidence about it — status tier decides", async () => {
  const t = await setup();
  try {
    const dir = join(tmpDir(), "claude-transcripts");
    mkdirSync(dir, { recursive: true });
    t.deps.profiles = new CliProfiles({
      profiles: [
        {
          kind: "claude",
          pin: { flag: "--session-id" },
          transcript: { via: "path", template: join(dir, "{sessionId}.jsonl") },
          terminal: CLAUDE_TERMINAL,
        },
      ],
    });
    t.fake.agents.push({ pane_id: "w8:p1", name: "claude-b", agent: "claude", agent_status: "blocked" });
    t.deps.index.set("default", "w8", { cwd: "/work/proj" });
    // startedAt is old (spawn happened long ago). Under a freshness rule
    // bound to spawn time, ANY record since then would count as fresh; this
    // proves freshness is bound to THIS wait's own start instead.
    t.deps.agents.set("default", "w8:p1", { sessionId: "sid-w8", kind: "claude", startedAt: 0 });
    writeFileSync(
      join(dir, "sid-w8.jsonl"),
      '{"type":"assistant","timestamp":"2020-01-01T00:00:00.000Z","message":{"role":"assistant","stop_reason":"end_turn"}}\n',
    );
    t.fake.handlers.set("agent.wait", () => ({
      type: "agent_info",
      agent: { pane_id: "w8:p1", name: "claude-b", agent: "claude", agent_status: "blocked" },
    }));
    const out = await runBrokerMethod(t.deps, "default", "broker.agent.wait", { pane_id: "w8:p1", until: ["blocked"] });
    assert.deepEqual(out, {
      waited: true,
      status: "blocked",
      raw_status: "blocked",
      evidence: "status",
      pane_id: "w8:p1",
    });
  } finally {
    await t.teardown();
  }
});

test("broker.agent.wait: output wait rides pane.wait_for_output and returns the matched line", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("pane.wait_for_output", () => ({
      type: "output_matched",
      pane_id: "w1:p1",
      matched_line: "│ Confirm folder trust │",
      read: { text: "big screen text" },
    }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.wait", {
      pane_id: "w1:p1",
      match: "trust",
      match_type: "substring",
    })) as { waited: boolean; matched_line: string; pane_id: string };
    assert.deepEqual(out, { waited: true, matched_line: "│ Confirm folder trust │", pane_id: "w1:p1" });
    const sent = t.fake.received.find((r) => r.method === "pane.wait_for_output");
    assert.deepEqual(sent?.params, {
      pane_id: "w1:p1",
      source: "visible",
      match: { type: "substring", value: "trust" },
      timeout_ms: 30_000,
    });
  } finally {
    await t.teardown();
  }
});

test("broker.agent.explain: passes through herdr's detection diagnostics", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("agent.explain", () => ({
      type: "agent_explain",
      explain: { agent: "copilot", evaluated_rules: [{ evidence: { all_count: 2 } }] },
    }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.explain", { pane_id: "w1:p1" })) as {
      pane_id: string;
      agent: string;
      kind: string;
      explain: { agent: string };
    };
    assert.equal(out.pane_id, "w1:p1");
    assert.equal(out.kind, "copilot");
    assert.equal(out.explain.agent, "copilot");
    const sent = t.fake.received.find((r) => r.method === "agent.explain");
    assert.deepEqual(sent?.params, { target: "copilot" });

    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.explain", { pane_id: "w9:p9" }),
      (e: BrokerError) => e.code === "bad_request" && /no agent in pane/.test(e.message),
    );
  } finally {
    await t.teardown();
  }
});

test("broker.agent.stop: closes the agent's pane; empty panes answer 'no agent in pane'", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("pane.close", () => ({ type: "ok" }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.stop", {
      pane_id: "w1:p1",
    })) as { stopped: boolean; pane_id: string; agent: string; kind: string };
    assert.deepEqual(out, { stopped: true, pane_id: "w1:p1", agent: "copilot", kind: "copilot" });
    const closed = t.fake.received.find((r) => r.method === "pane.close");
    assert.deepEqual(closed?.params, { pane_id: "w1:p1" });

    // a pane with no agent is not "stopped" silently — same contract as prompt/slash
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.stop", { pane_id: "w9:p9" }),
      (e: BrokerError) => e.code === "bad_request" && /no agent in pane/.test(e.message),
    );
  } finally {
    await t.teardown();
  }
});

test("broker.workspace.close: closes at herdr and drops the index entry", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w7", { cwd, label: "old team" });
    t.fake.handlers.set("workspace.close", () => ({ type: "ok" }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.workspace.close", {
      workspace_id: "w7",
    })) as { workspace_id: string; closed: boolean };
    assert.deepEqual(out, { workspace_id: "w7", closed: true });
    const closed = t.fake.received.find((r) => r.method === "workspace.close");
    assert.deepEqual(closed?.params, { workspace_id: "w7" });
    assert.equal(t.deps.index.get("default", "w7"), undefined, "index entry removed");

    // herdr refusing an unknown workspace surfaces as its own error
    t.fake.handlers.set("workspace.close", () => {
      throw new FakeHerdrError("workspace_not_found", "no workspace w9");
    });
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.workspace.close", { workspace_id: "w9" }),
      (e: BrokerError) => e.code === "workspace_not_found",
    );
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

test("broker.agent.slash: types /command into the pane; args join on one line", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    const bare = (await runBrokerMethod(t.deps, "default", "broker.agent.slash", {
      pane_id: "w1:p1",
      command: "clear",
    })) as { status: string; kind: string; command: string };
    assert.deepEqual(bare, { status: "sent", pane_id: "w1:p1", kind: "copilot", command: "/clear" });
    const withArgs = (await runBrokerMethod(t.deps, "default", "broker.agent.slash", {
      pane_id: "w1:p1",
      command: "instructions",
      args: "keep answers short",
    })) as { command: string };
    assert.equal(withArgs.command, "/instructions keep answers short");
    const frames = t.fake.received.filter((r) => r.method === "pane.send_input");
    assert.deepEqual(frames.map((f) => (f.params as { text: string }).text), [
      "/clear",
      "/instructions keep answers short",
    ]);
    assert.ok(frames.every((f) => (f.params as { keys: string[] }).keys[0] === "Enter"));
  } finally {
    await t.teardown();
  }
});

test("broker.agent.slash: multi-line args are rejected before anything reaches the pane", async () => {
  const t = await setup();
  try {
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.slash", {
        pane_id: "w1:p1",
        command: "instructions",
        args: "line one\n/model gpt-5",
      }),
      (e: BrokerError) => e.code === "bad_request" && /single line/.test(e.message),
    );
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.slash", { pane_id: "w1:p1", command: "cl ear" }),
      (e: BrokerError) => e.code === "bad_request" && /command/.test(e.message),
    );
    assert.ok(!t.fake.received.some((r) => r.method === "pane.send_input"));
  } finally {
    await t.teardown();
  }
});

test("broker.agent.slash: no agent in the pane is a bad_request", async () => {
  const t = await setup();
  try {
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.slash", { pane_id: "w9:p9", command: "clear" }),
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

test("broker.agent.prompt: fire-and-forget steering to the pane's agent by name", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.prompt", {
      pane_id: "w1:p1",
      text: "actually, use OAuth\nand keep the session table",
    })) as { status: string; kind: string; agent: string };
    assert.deepEqual(out, { status: "prompted", pane_id: "w1:p1", kind: "copilot", agent: "copilot" });
    const sent = t.fake.received.find((r) => r.method === "agent.prompt");
    assert.deepEqual(sent?.params, { target: "copilot", text: "actually, use OAuth\nand keep the session table" });
  } finally {
    await t.teardown();
  }
});

test("broker.agent.prompt: a just-launched agent listed without its kind is re-polled, not failed", async () => {
  const t = await setup();
  t.deps.paneBusyDelayMs = 5;
  try {
    let lists = 0;
    t.fake.handlers.set("agent.list", () => ({
      type: "agent_list",
      agents: [
        ++lists < 2
          ? { pane_id: "w1:p1", name: "copilot", agent_status: "idle" } // launch window: no `agent` field yet
          : { pane_id: "w1:p1", name: "copilot", agent: "copilot", agent_status: "idle" },
      ],
    }));
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.prompt", {
      pane_id: "w1:p1",
      text: "hello",
    })) as { kind: string };
    assert.equal(out.kind, "copilot");
    assert.ok(lists >= 2, "the kindless listing was re-polled");
  } finally {
    await t.teardown();
  }
});

test("broker.agent.prompt: empty text and empty panes are bad_request; nothing reaches herdr", async () => {
  const t = await setup();
  try {
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.prompt", { pane_id: "w1:p1", text: "" }),
      (e: BrokerError) => e.code === "bad_request",
    );
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.prompt", { pane_id: "w9:p9", text: "hello" }),
      (e: BrokerError) => e.code === "bad_request" && /no agent in pane/.test(e.message),
    );
    assert.ok(!t.fake.received.some((r) => r.method === "agent.prompt"));
  } finally {
    await t.teardown();
  }
});

test("broker.context.*: base64 round-trip through put/list/get/set/delete", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    const bytes = Buffer.from("fake-pdf-bytes");
    const put = (await runBrokerMethod(t.deps, "default", "broker.context.put", {
      workspace_id: "w1",
      name: "spec.pdf",
      content_b64: bytes.toString("base64"),
      content_type: "application/pdf",
    })) as { name: string; size: number; active: boolean };
    assert.deepEqual([put.name, put.size, put.active], ["spec.pdf", bytes.length, true]);

    const listed = (await runBrokerMethod(t.deps, "default", "broker.context.list", { workspace_id: "w1" })) as {
      attachments: { name: string; content_type: string }[];
    };
    assert.equal(listed.attachments[0].content_type, "application/pdf");

    const got = (await runBrokerMethod(t.deps, "default", "broker.context.get", {
      workspace_id: "w1",
      name: "spec.pdf",
    })) as { content_b64: string; content_type: string };
    assert.equal(Buffer.from(got.content_b64, "base64").toString(), "fake-pdf-bytes");

    await runBrokerMethod(t.deps, "default", "broker.context.set", { workspace_id: "w1", name: "spec.pdf", active: false });
    await runBrokerMethod(t.deps, "default", "broker.context.delete", { workspace_id: "w1", name: "spec.pdf" });
    const empty = (await runBrokerMethod(t.deps, "default", "broker.context.list", { workspace_id: "w1" })) as {
      attachments: unknown[];
    };
    assert.equal(empty.attachments.length, 0);
  } finally {
    await t.teardown();
  }
});

test("active context rides prompt and ask text; inactive context stays out", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    await runBrokerMethod(t.deps, "default", "broker.context.put", {
      workspace_id: "w1",
      name: "mockup.png",
      content_b64: Buffer.from("png").toString("base64"),
      content_type: "image/png",
    });

    await runBrokerMethod(t.deps, "default", "broker.agent.prompt", { pane_id: "w1:p1", text: "build the header" });
    let text = String((t.fake.received.filter((r) => r.method === "agent.prompt").at(-1)?.params as { text: string }).text);
    assert.ok(text.includes("Context files attached"), "steering carries the context preamble");
    assert.ok(text.includes("mockup.png") && text.includes("image/png"));
    assert.ok(text.endsWith("build the header"), "the human's text comes last, unmodified");

    await runBrokerMethod(t.deps, "default", "broker.context.set", { workspace_id: "w1", name: "mockup.png", active: false });
    await runBrokerMethod(t.deps, "default", "broker.agent.prompt", { pane_id: "w1:p1", text: "no context now" });
    text = String((t.fake.received.filter((r) => r.method === "agent.prompt").at(-1)?.params as { text: string }).text);
    assert.ok(!text.includes("Context files attached"), "inactive attachments stay out of prompts");
  } finally {
    await t.teardown();
  }
});

test("spec bundle drive: creates the bundle dir with a seeded overview and sends the drafting contract", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    const out = (await runBrokerMethod(t.deps, "default", "broker.spec.drive", {
      pane_id: "w1:p1",
      name: "Checkout Flow",
      prompt: "draft the checkout flow design",
    })) as { bundle: string; dir: string; files: string[]; version: string };
    assert.match(out.bundle, /^\d{4}-\d{2}-\d{2}-checkout-flow$/);
    assert.equal(out.dir, `docs/superpowers/specs/${out.bundle}`);
    assert.deepEqual(out.files, ["overview.md"]);
    assert.ok(existsSync(join(cwd, out.dir, "overview.md")), "overview seeded on disk");
    const prompted = t.fake.received.find((r) => r.method === "agent.prompt");
    const text = String((prompted?.params as { text: string }).text);
    assert.ok(text.includes(out.dir), "contract names the bundle dir");
    assert.ok(text.includes("overview.md"), "contract names the entry file");
    assert.ok(text.includes("draft the checkout flow design"), "contract carries the instruction");
    assert.ok(/Open questions/.test(text), "contract tells the agent where to ask the human");
  } finally {
    await t.teardown();
  }
});

test("spec bundle drive: re-driving an existing bundle never clobbers its content", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    const first = (await runBrokerMethod(t.deps, "default", "broker.spec.drive", {
      pane_id: "w1:p1",
      name: "thing",
      prompt: "start",
    })) as { bundle: string; dir: string };
    writeFileSync(join(cwd, first.dir, "overview.md"), "# thing\n\nreal content the agent wrote\n");
    await runBrokerMethod(t.deps, "default", "broker.spec.drive", {
      pane_id: "w1:p1",
      bundle: first.bundle,
      prompt: "answer: use OAuth",
    });
    assert.match(readFileSync(join(cwd, first.dir, "overview.md"), "utf8"), /real content the agent wrote/);
  } finally {
    await t.teardown();
  }
});

test("spec bundle drive: names that don't slug to [a-z0-9-] are rejected", async () => {
  const t = await setup();
  try {
    t.deps.index.set("default", "w1", { cwd: scratchRepo() });
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.spec.drive", {
        pane_id: "w1:p1",
        bundle: "../../etc/passwd",
        prompt: "x",
      }),
      (e: BrokerError) => e.code === "bad_request",
    );
  } finally {
    await t.teardown();
  }
});

test("spec bundle get: returns both files with a combined version; long-poll sees live updates", async () => {
  const t = await setup();
  t.deps.filePollMs = 25;
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    const made = (await runBrokerMethod(t.deps, "default", "broker.spec.drive", {
      pane_id: "w1:p1",
      name: "live",
      prompt: "go",
    })) as { bundle: string; dir: string };

    const got = (await runBrokerMethod(t.deps, "default", "broker.spec.get", {
      workspace_id: "w1",
      bundle: made.bundle,
    })) as { version: string; files: Record<string, { content: string }> };
    assert.ok(got.files["overview.md"].content.length > 0);

    // unchanged long-poll: same version + wait → {unchanged}
    const idle = (await runBrokerMethod(t.deps, "default", "broker.spec.get", {
      workspace_id: "w1",
      bundle: made.bundle,
      version: got.version,
      wait_ms: 200,
    })) as { unchanged?: boolean };
    assert.equal(idle.unchanged, true);

    // a NEW member file lands mid-wait → the combined version moves and the
    // long-poll returns it (adding files counts as an update, not just edits)
    setTimeout(() => writeFileSync(join(cwd, made.dir, "api.md"), "# api\n\n## Open questions\n- pick a db?\n"), 80);
    const fresh = (await runBrokerMethod(t.deps, "default", "broker.spec.get", {
      workspace_id: "w1",
      bundle: made.bundle,
      version: got.version,
      wait_ms: 3000,
    })) as { version: string; files: Record<string, { content: string }> };
    assert.notEqual(fresh.version, got.version);
    assert.match(fresh.files["api.md"].content, /pick a db\?/);
  } finally {
    await t.teardown();
  }
});

test("spec bundle get/list: unknown bundle 404s; list finds bundles on disk", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.spec.get", { workspace_id: "w1", bundle: "2026-01-01-ghost" }),
      (e: BrokerError) => e.code === "unknown_bundle",
    );
    const a = (await runBrokerMethod(t.deps, "default", "broker.spec.drive", {
      pane_id: "w1:p1",
      name: "alpha",
      prompt: "x",
    })) as { bundle: string };
    const listed = (await runBrokerMethod(t.deps, "default", "broker.spec.list", { workspace_id: "w1" })) as {
      bundles: { bundle: string; files: string[] }[];
    };
    assert.deepEqual(listed.bundles.map((b) => [b.bundle, b.files]), [[a.bundle, ["overview.md"]]]);
  } finally {
    await t.teardown();
  }
});

test("spec bundle drive: an active file focuses the contract (and its questions) on that page", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    const made = (await runBrokerMethod(t.deps, "default", "broker.spec.drive", {
      pane_id: "w1:p1",
      name: "focused",
      prompt: "start",
    })) as { bundle: string };
    await runBrokerMethod(t.deps, "default", "broker.spec.drive", {
      pane_id: "w1:p1",
      bundle: made.bundle,
      file: "api.md",
      prompt: "add the pagination endpoints",
    });
    const text = String((t.fake.received.filter((r) => r.method === "agent.prompt").at(-1)?.params as { text: string }).text);
    assert.ok(/api\.md/.test(text), "contract names the active file");
    assert.ok(/Open questions/.test(text) && text.indexOf("api.md") < text.indexOf("Open questions"), "questions target the active page");
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.spec.drive", {
        pane_id: "w1:p1",
        bundle: made.bundle,
        file: "../escape.md",
        prompt: "x",
      }),
      (e: BrokerError) => e.code === "bad_request",
    );
  } finally {
    await t.teardown();
  }
});

test("spec bundle plan: prompts the agent to write plan.md from the bundle; unknown bundle 404s", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.spec.plan", { pane_id: "w1:p1", bundle: "2026-01-01-ghost" }),
      (e: BrokerError) => e.code === "unknown_bundle",
    );
    const made = (await runBrokerMethod(t.deps, "default", "broker.spec.drive", {
      pane_id: "w1:p1",
      name: "planned",
      prompt: "spec it",
    })) as { bundle: string; dir: string };
    const out = (await runBrokerMethod(t.deps, "default", "broker.spec.plan", {
      pane_id: "w1:p1",
      bundle: made.bundle,
      prompt: "sequence backend before UI",
    })) as { bundle: string; file: string; status: string };
    assert.equal(out.status, "prompted");
    assert.equal(out.file, "plan.md");
    const planPrompt = t.fake.received.filter((r) => r.method === "agent.prompt").at(-1);
    const text = String((planPrompt?.params as { text: string }).text);
    assert.ok(text.includes(`${made.dir}/plan.md`), "contract names the plan file inside the bundle");
    assert.ok(/implementation plan/i.test(text), "contract asks for an implementation plan");
    assert.ok(text.includes("sequence backend before UI"), "extra guidance rides along");
  } finally {
    await t.teardown();
  }
});

test("pane screen: returns text with a version hash; matching version long-polls to unchanged", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("pane.read", () => ({ type: "pane_read", read: { text: "❯ npm test\nall green ▌" } }));
    const first = (await runBrokerMethod(t.deps, "default", "broker.pane.screen", { pane_id: "w1:p1" })) as {
      pane_id: string;
      source: string;
      text: string;
      version: string;
      as_of: string;
    };
    assert.equal(first.pane_id, "w1:p1");
    assert.equal(first.source, "visible");
    assert.equal(first.text, "❯ npm test\nall green ▌");
    assert.match(first.version, /^[a-f0-9]{16}$/);
    assert.ok(first.as_of);

    // same screen + known version + no wait → immediate unchanged, no text payload
    const again = (await runBrokerMethod(t.deps, "default", "broker.pane.screen", {
      pane_id: "w1:p1",
      version: first.version,
    })) as { unchanged?: boolean; version: string; text?: string };
    assert.equal(again.unchanged, true);
    assert.equal(again.version, first.version);
    assert.equal(again.text, undefined);
  } finally {
    await t.teardown();
  }
});

test("pane screen: long-poll returns the moment the screen changes, not at the deadline", async () => {
  const t = await setup();
  t.deps.screenPollMs = 25;
  try {
    let screenText = "frame one";
    t.fake.handlers.set("pane.read", () => ({ type: "pane_read", read: { text: screenText } }));
    const v1 = ((await runBrokerMethod(t.deps, "default", "broker.pane.screen", { pane_id: "w1:p1" })) as {
      version: string;
    }).version;

    setTimeout(() => (screenText = "frame two"), 100);
    const started = Date.now();
    const changed = (await runBrokerMethod(t.deps, "default", "broker.pane.screen", {
      pane_id: "w1:p1",
      version: v1,
      wait_ms: 5000,
    })) as { text: string; version: string; unchanged?: boolean };
    assert.equal(changed.text, "frame two");
    assert.notEqual(changed.version, v1);
    assert.equal(changed.unchanged, undefined);
    // returned on the change (~100ms), not the 5s deadline
    assert.ok(Date.now() - started < 3000);
  } finally {
    await t.teardown();
  }
});

test("pane screen: 'recent' passes through to herdr; other sources are rejected; herdr errors surface", async () => {
  const t = await setup();
  try {
    t.fake.handlers.set("pane.read", () => ({ type: "pane_read", read: { text: "scrollback…" } }));
    const r = (await runBrokerMethod(t.deps, "default", "broker.pane.screen", {
      pane_id: "w1:p1",
      source: "recent",
    })) as { source: string; text: string };
    assert.equal(r.source, "recent");
    const sent = t.fake.received.find((f) => f.method === "pane.read")?.params as { source: string };
    assert.equal(sent.source, "recent");

    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.pane.screen", { pane_id: "w1:p1", source: "history" }),
      (e: BrokerError) => e.code === "bad_request",
    );

    t.fake.handlers.set("pane.read", () => {
      throw new FakeHerdrError("pane_not_found", "no pane w9:p9");
    });
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.pane.screen", { pane_id: "w9:p9" }),
      (e: BrokerError) => e.code === "pane_not_found",
    );
  } finally {
    await t.teardown();
  }
});

test("pane screen: oversized scrollback keeps the TAIL — the recent end is the part that matters", async () => {
  const t = await setup();
  try {
    const big = "x".repeat(300_000) + "THE END";
    t.fake.handlers.set("pane.read", () => ({ type: "pane_read", read: { text: big } }));
    const r = (await runBrokerMethod(t.deps, "default", "broker.pane.screen", {
      pane_id: "w1:p1",
      source: "recent",
    })) as { text: string; truncated?: boolean };
    assert.equal(r.truncated, true);
    assert.ok(r.text.endsWith("THE END"));
    assert.ok(r.text.length <= 262_144);
  } finally {
    await t.teardown();
  }
});

test("ask: a second concurrent ask on the same pane answers 409 pane_busy; steering stays allowed", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    t.fake.handlers.set("agent.prompt", (p) => {
      const text = String((p as { text: string }).text);
      const m = /\.herdr\/answers\/([a-f0-9]{16})\.json/.exec(text);
      if (m) setTimeout(() => writeFileSync(join(cwd, ".herdr", "answers", `${m[1]}.json`), '{"answer":1}'), 300);
      return { type: "prompted" };
    });
    mkdirSync(join(cwd, ".herdr", "answers"), { recursive: true });

    const first = runBrokerMethod(t.deps, "default", "broker.agent.ask", {
      pane_id: "w1:p1",
      prompt: "slow question",
      timeout_ms: 5000,
    });
    await new Promise((r) => setTimeout(r, 60)); // first ask is now in flight

    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.ask", { pane_id: "w1:p1", prompt: "too eager", timeout_ms: 5000 }),
      (e: BrokerError) => e.code === "pane_busy" && e.details.pane_id === "w1:p1",
    );

    // mid-ask steering is a FEATURE — it must not be blocked by the lock
    const steer = (await runBrokerMethod(t.deps, "default", "broker.agent.prompt", {
      pane_id: "w1:p1",
      text: "also include totals",
    })) as { status: string };
    assert.equal(steer.status, "prompted");

    assert.deepEqual(((await first) as { answer: unknown }).answer, 1);

    // lock released after completion — a new ask works
    const again = (await runBrokerMethod(t.deps, "default", "broker.agent.ask", {
      pane_id: "w1:p1",
      prompt: "next question",
      timeout_ms: 5000,
    })) as { answer: unknown };
    assert.deepEqual(again.answer, 1);
  } finally {
    await t.teardown();
  }
});

test("ask: the pane lock releases even when the ask fails", async () => {
  const t = await setup();
  t.deps.askStartGraceMs = 100;
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w9", { cwd });
    t.fake.agents.push({ pane_id: "w9:p1", name: "deadish", agent: "copilot", agent_status: "idle" });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.ask", { pane_id: "w9:p1", prompt: "x", timeout_ms: 5000 }),
      (e: BrokerError) => e.code === "agent_unresponsive",
    );
    // failure must not leave the pane permanently busy
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.ask", { pane_id: "w9:p1", prompt: "y", timeout_ms: 5000 }),
      (e: BrokerError) => e.code === "agent_unresponsive",
    );
  } finally {
    await t.teardown();
  }
});

test("ask: an agent that never starts working fails fast as agent_unresponsive, not a full-budget hang", async () => {
  const t = await setup();
  t.deps.askStartGraceMs = 120;
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w9", { cwd });
    t.fake.agents.push({ pane_id: "w9:p1", name: "deadone", agent: "copilot", agent_status: "idle" });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    const started = Date.now();
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.ask", {
        pane_id: "w9:p1",
        prompt: "anyone home?",
        timeout_ms: 30_000,
      }),
      (e: BrokerError) => e.code === "agent_unresponsive",
    );
    assert.ok(Date.now() - started < 3_000, "must fail at the start grace, not the 30s budget");
  } finally {
    await t.teardown();
  }
});

test("ask: a transcript proving the turn finished, with no answer file, gets the transcript-specific agent_unresponsive message", async () => {
  const t = await setup();
  t.deps.askStartGraceMs = 100;
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w10", { cwd });
    const dir = join(tmpDir(), "claude-transcripts");
    mkdirSync(dir, { recursive: true });
    t.deps.profiles = new CliProfiles({
      profiles: [
        {
          kind: "claude",
          pin: { flag: "--session-id" },
          transcript: { via: "path", template: join(dir, "{sessionId}.jsonl") },
          terminal: { done: ["end_turn", "stop_sequence", "max_tokens", "refusal"], blocked: ["tool_use"], running: [] },
        },
      ],
    });
    t.fake.agents.push({ pane_id: "w10:p1", name: "claude-c", agent: "claude", agent_status: "idle" });
    t.deps.agents.set("default", "w10:p1", { sessionId: "sid-w10", kind: "claude", startedAt: 0 });
    // Fresh (future-dated) and DONE from the first poll onward — herdr's
    // own agent_status is irrelevant here, the transcript alone drives it.
    writeFileSync(
      join(dir, "sid-w10.jsonl"),
      '{"type":"assistant","timestamp":"2030-01-01T00:00:00.000Z","message":{"role":"assistant","stop_reason":"end_turn"}}\n',
    );
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.ask", { pane_id: "w10:p1", prompt: "x", timeout_ms: 5000 }),
      (e: BrokerError) =>
        e.code === "agent_unresponsive" &&
        e.details.evidence === "transcript" &&
        /finished its turn \(per its own transcript\) but wrote no answer file/.test(e.message),
    );
  } finally {
    await t.teardown();
  }
});

test("ask: the contract demands an {\"answer\": …} envelope and the broker unwraps it", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", (p) => {
      const text = String((p as { text: string }).text);
      assert.ok(text.includes(`{"answer":`), "instruction specifies the envelope shape");
      const file = extractAnswerPath(cwd, text);
      setTimeout(() => writeFileSync(file, '{"answer":{"x":1}}'), 50);
      return { type: "prompted" };
    });
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.ask", {
      pane_id: "w1:p1",
      prompt: "give me x",
      timeout_ms: 5000,
    })) as { answer: unknown };
    assert.deepEqual(out.answer, { x: 1 }, "envelope unwrapped to the inner answer");
  } finally {
    await t.teardown();
  }
});

test("repo file read: content with version-safe caps; traversal, .git, and missing paths refused", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    const ok = (await runBrokerMethod(t.deps, "default", "broker.repo.file", {
      workspace_id: "w1",
      repo: "-",
      path: "a.txt",
    })) as { content: string; size: number; path: string };
    assert.equal(ok.content, "one\n");
    assert.equal(ok.size, 4);
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.repo.file", { workspace_id: "w1", repo: "-", path: "../escape" }),
      (e: BrokerError) => e.code === "bad_request",
    );
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.repo.file", { workspace_id: "w1", repo: "-", path: ".git/config" }),
      (e: BrokerError) => e.code === "bad_request",
    );
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.repo.file", { workspace_id: "w1", repo: "-", path: "nope.txt" }),
      (e: BrokerError) => e.code === "unknown_file",
    );
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
    assert.deepEqual(readdirSync(outside), [], "the escape guard runs before anything is created through it");
  } finally {
    await t.teardown();
  }
});

// The deeper form of the same escape: .herdr ITSELF is the symlink, not
// just the leaf under it. `answers` doesn't exist yet at all in this
// case — a guard that only checks `dir`'s own existence would miss an
// already-malicious .herdr and let mkdirSync create `answers` (and any
// later write) through it before ever resolving the escape.
test("ask: .herdr itself symlinked outside the workspace is rejected before anything is created through it", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    const outside = tmpDir();
    symlinkSync(outside, join(cwd, ".herdr"));
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("agent.prompt", () => ({ type: "prompted" }));
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.ask", { pane_id: "w1:p1", prompt: "x", timeout_ms: 1000 }),
      (e: BrokerError) => e.code === "unknown_workspace",
    );
    assert.deepEqual(readdirSync(outside), [], "no 'answers' dir created inside the symlinked .herdr target");
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

test("spawn: prepareWorkspace failing degrades to no injected env rather than failing the spawn", async () => {
  const t = await setup();
  try {
    armSpawnFake(t.fake);
    const cwd = scratchRepo();
    // stateDir/cli-config can't become a directory: a FILE already sits
    // where prepareWorkspace needs to mkdir — same failure shape as a
    // read-only stateDir or a cli-config/claude the broker doesn't own.
    // The trust-dialog convenience must never cost a spawn that would
    // otherwise have succeeded.
    const blockedState = tmpDir();
    writeFileSync(join(blockedState, "cli-config"), "not a directory");
    t.deps.stateDir = blockedState;
    const out = (await runBrokerMethod(t.deps, "default", "broker.agent.spawn", {
      kind: "claude",
      cwd,
    })) as { workspace_id: string };
    assert.equal(out.workspace_id, "w9", "the spawn still succeeds");
    assert.ok(!t.fake.received.some((r) => r.method === "pane.send_input"), "nothing to inject once prepareWorkspace degrades to {}");
  } finally {
    await t.teardown();
  }
});

test("spawn: a pane that renders ready then goes unready within the settle window fails the spawn", async () => {
  const t = await setup();
  t.deps.settleMsOverride = 300;
  try {
    armSpawnFake(t.fake);
    // agent.list is read live on each poll (test/fake-herdr.ts). The first
    // sample catches the pane freshly ready; the second (after one 250ms
    // gap, per settleMs=300) catches it having crashed — the render-then-die
    // sequence this whole task exists to reject, not merely "never ready".
    let calls = 0;
    t.fake.handlers.set("agent.list", () => {
      calls++;
      return {
        type: "agent_list",
        agents: [{ pane_id: "w9:p1", name: "copilot", agent: "copilot", agent_status: "working", interactive_ready: calls === 1 }],
      };
    });
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.agent.spawn", { kind: "copilot", cwd: scratchRepo() }),
      (e: BrokerError) =>
        e.code === "upstream_error" &&
        /became ready then stopped being ready/.test(e.message) &&
        e.details.pane_id === "w9:p1" &&
        e.details.workspace_id === "w9",
    );
    assert.ok(calls >= 2, "must have sampled at least twice to observe the drop");
  } finally {
    await t.teardown();
  }
});
