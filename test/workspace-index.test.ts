import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceIndex } from "../src/state.js";
import { tmpDir } from "./util.js";

test("WorkspaceIndex persists per-session workspace metadata across instances", () => {
  const dir = tmpDir();
  const a = new WorkspaceIndex(dir);
  a.set("default", "w2", { cwd: "/work", label: "demo" });
  a.set("other", "w1", { cwd: "/elsewhere" });
  assert.deepEqual(a.get("default", "w2"), { cwd: "/work", label: "demo" });
  assert.equal(a.get("default", "ghost"), undefined);
  // a fresh instance over the same stateDir sees the same data (file-backed)
  const b = new WorkspaceIndex(dir);
  assert.deepEqual(b.all("default"), { w2: { cwd: "/work", label: "demo" } });
  assert.deepEqual(b.all("missing"), {});
});

test("removeSession clears every workspace row for a session, leaves other sessions untouched", () => {
  // Mirrors AgentIndex.removeSession. Teardown kills the whole herdr process,
  // so every workspace row for that session must die with it — not just the
  // ones herdr happened to still list.
  const dir = tmpDir();
  const a = new WorkspaceIndex(dir);
  a.set("s1", "w1", { cwd: "/one" });
  a.set("s1", "w2", { cwd: "/two" });
  a.set("s2", "w1", { cwd: "/other" });
  a.removeSession("s1");
  assert.deepEqual(a.all("s1"), {});
  assert.deepEqual(a.all("s2"), { w1: { cwd: "/other" } }, "a sibling session is untouched");
  // file-backed, like every other mutation here
  assert.deepEqual(new WorkspaceIndex(dir).all("s1"), {});
});

test("removeSession on a session with no rows is a no-op, not a write", () => {
  const dir = tmpDir();
  const a = new WorkspaceIndex(dir);
  a.set("s1", "w1", { cwd: "/one" });
  a.removeSession("ghost");
  assert.deepEqual(a.all("s1"), { w1: { cwd: "/one" } });
});
