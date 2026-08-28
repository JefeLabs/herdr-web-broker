import test from "node:test";
import assert from "node:assert/strict";
import { CliProfiles } from "../src/cli-profiles.js";

test("builtins: claude and opencode pin, codex and copilot do not", () => {
  const p = new CliProfiles();
  assert.equal(p.get("claude")?.pin?.flag, "--session-id");
  assert.equal(p.get("opencode")?.pin?.flag, "--session");
  assert.equal(p.get("codex")?.pin, undefined);
  assert.equal(p.get("copilot")?.pin, undefined);
});

test("builtins: each verified kind names its own storage model", () => {
  const p = new CliProfiles();
  assert.equal(p.get("agy")?.transcript?.via, "map");
  assert.equal(p.get("claude")?.transcript?.via, "path");
  assert.equal(p.get("opencode")?.transcript?.via, "sqlite");
  assert.equal(p.get("codex")?.transcript, undefined, "unverified formats ship absent, not stubbed");
  assert.equal(p.get("copilot")?.transcript, undefined);
});

test("builtins: terminal vocabularies are per-kind", () => {
  const p = new CliProfiles();
  assert.ok(p.get("claude")?.terminal?.done.includes("end_turn"));
  assert.ok(p.get("agy")?.terminal?.blocked.includes("ASK_QUESTION"));
  assert.ok(p.get("agy")?.terminal?.running.includes("RUNNING"));
});

test("config rows override builtins by kind and mark themselves", () => {
  const p = new CliProfiles({
    profiles: [{ kind: "codex", settleMs: 9000, terminal: { done: ["X"], blocked: [], running: [] } }],
  });
  assert.equal(p.get("codex")?.settleMs, 9000);
  assert.equal(p.get("codex")?.source, "config");
  assert.equal(p.get("claude")?.source, "builtin");
  assert.equal(p.list().filter((x) => x.kind === "codex").length, 1, "override replaces, not duplicates");
});

test("unknown kind is undefined, never a throw", () => {
  assert.equal(new CliProfiles().get("no-such-cli"), undefined);
});
