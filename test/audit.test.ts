import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Audit } from "../src/audit.js";
import { tmpDir } from "./util.js";

test("record appends JSONL with a timestamp; tail returns the last N, oldest first", () => {
  const path = join(tmpDir(), "audit.log");
  const audit = new Audit(path);
  audit.record({ action: "token.mint", actor: "admin", target: "guest", remote: "127.0.0.1" });
  audit.record({ action: "kick", actor: "admin", target: "guest", remote: "127.0.0.1" });
  audit.record({ action: "env.set", actor: "t", target: "COPILOT_GITHUB_TOKEN" });

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]) as { ts: string; action: string };
  assert.ok(first.ts.includes("T"), "ISO timestamp");
  assert.equal(first.action, "token.mint");

  const tail2 = audit.tail(2);
  assert.deepEqual(tail2.map((e) => e.action), ["kick", "env.set"]);
  assert.equal(tail2[1].actor, "t");
});

test("tail skips malformed lines instead of throwing — the log is append-only forever", () => {
  const path = join(tmpDir(), "audit.log");
  const audit = new Audit(path);
  audit.record({ action: "kick", actor: "admin" });
  appendFileSync(path, "not json\n");
  audit.record({ action: "token.revoke", actor: "admin" });
  assert.deepEqual(audit.tail(10).map((e) => e.action), ["kick", "token.revoke"]);
});

test("tail on a missing file is an empty list, not an error", () => {
  const audit = new Audit(join(tmpDir(), "never-written.log"));
  assert.deepEqual(audit.tail(5), []);
});
