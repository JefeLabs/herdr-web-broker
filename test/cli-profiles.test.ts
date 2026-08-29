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
  // codex joined the verified set when WT-4 answered (2026-08-29): no pinnable
  // id, so it discovers by the cwd the rollout records — a fourth storage
  // model, not a variant of the other three.
  assert.equal(p.get("codex")?.transcript?.via, "scan");
  // copilot is still unverified: WT-5 ran but could not clear the first-run
  // trust gate, so whether a completed turn writes a `turns` row is unknown.
  assert.equal(p.get("copilot")?.transcript, undefined, "unverified formats ship absent, not stubbed");
});

test("builtins: the scan via names a DATE-partitioned directory, not a flat one", () => {
  // The partition is what makes scanning viable on a 500ms ask poll: a working
  // machine held ~26k rollouts / 510MB, so walking all of them cost ~210ms
  // against ~1ms for one day. A template that lost its date segments would
  // still resolve — and would silently reintroduce that cost.
  const src = new CliProfiles().get("codex")?.transcript;
  assert.equal(src?.via, "scan");
  if (src?.via !== "scan") return;
  for (const seg of ["{YYYY}", "{MM}", "{DD}"]) {
    assert.ok(src.dirTemplate.includes(seg), `dirTemplate must stay date-partitioned, missing ${seg}`);
  }
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
