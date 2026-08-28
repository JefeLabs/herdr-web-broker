// test/decide-turn.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { decideTurn } from "../src/transcript.js";

const T0 = Date.parse("2026-08-27T10:00:00.000Z");
const after = (ms: number) => ({ state: "done" as const, lastRecordAt: T0 + ms });

test("fresh transcript wins over agent_status and says so", () => {
  const d = decideTurn(after(5000), { status: "working", raw_status: "working" }, T0);
  assert.equal(d.status, "idle", "done folds to idle on the wire");
  assert.equal(d.raw_status, "done", "raw_status carries the unfolded truth");
  assert.equal(d.evidence, "transcript");
});

test("a transcript older than the prompt is not evidence about THIS turn", () => {
  const stale = { state: "done" as const, lastRecordAt: T0 - 1 };
  const d = decideTurn(stale, { status: "working", raw_status: "working" }, T0);
  assert.equal(d.status, "working");
  assert.equal(d.evidence, "status");
});

test("a record exactly at promptedAt counts as fresh (boundary is inclusive)", () => {
  assert.equal(decideTurn(after(0), { status: "working" }, T0).evidence, "transcript");
});

test("no transcript falls back to status, unchanged", () => {
  const d = decideTurn(null, { status: "blocked", raw_status: "blocked" }, T0);
  assert.equal(d.status, "blocked");
  assert.equal(d.raw_status, "blocked");
  assert.equal(d.evidence, "status");
});

test("transcript blocked and working map through without folding", () => {
  assert.equal(decideTurn({ state: "blocked", lastRecordAt: T0 + 1 }, { status: "idle" }, T0).status, "blocked");
  assert.equal(decideTurn({ state: "working", lastRecordAt: T0 + 1 }, { status: "idle" }, T0).status, "working");
});

test("status tier coerces an unrecognized raw status to idle", () => {
  const d = decideTurn(null, { status: "idle", raw_status: "unknown" }, T0);
  assert.equal(d.status, "idle");
  assert.equal(d.raw_status, "unknown", "the fold is visible, not erased");
});
