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
