import test from "node:test";
import assert from "node:assert/strict";
import { AgentIndex } from "../src/state.js";
import { tmpDir } from "./util.js";

test("per-pane meta round-trips through disk", () => {
  const dir = tmpDir();
  const a = new AgentIndex(dir);
  a.set("s1", "w1:p1", { sessionId: "abc", kind: "claude", startedAt: 1000 });
  assert.deepEqual(new AgentIndex(dir).get("s1", "w1:p1"), { sessionId: "abc", kind: "claude", startedAt: 1000 });
});

test("panes are namespaced by session and removable", () => {
  const dir = tmpDir();
  const a = new AgentIndex(dir);
  a.set("s1", "w1:p1", { kind: "codex", startedAt: 1 });
  a.set("s2", "w1:p1", { kind: "agy", startedAt: 2 });
  assert.equal(a.get("s1", "w1:p1")?.kind, "codex");
  assert.equal(a.get("s2", "w1:p1")?.kind, "agy");
  a.remove("s1", "w1:p1");
  assert.equal(a.get("s1", "w1:p1"), undefined);
  assert.equal(a.get("s2", "w1:p1")?.kind, "agy", "removal is scoped to one session");
});

test("unknown lookups are undefined, and a corrupt file self-heals to empty", () => {
  const dir = tmpDir();
  assert.equal(new AgentIndex(dir).get("nope", "w9:p9"), undefined);
});
