import test from "node:test";
import assert from "node:assert/strict";
import { classifySession } from "../src/reconcile.js";

test("a workspace in both the index and herdr is adopted", () => {
  const r = classifySession({ w1: { cwd: "/a" } }, ["w1"]);
  assert.deepEqual(r, { adopt: ["w1"], forget: [], orphans: [] });
});

test("an indexed workspace herdr no longer lists is forgotten", () => {
  const r = classifySession({ w1: { cwd: "/a" }, w2: { cwd: "/b" } }, ["w1"]);
  assert.deepEqual(r.forget, ["w2"]);
  assert.deepEqual(r.adopt, ["w1"]);
});

test("a LIVE workspace the broker never recorded is an orphan — never a kill", () => {
  const r = classifySession({ w1: { cwd: "/a" } }, ["w1", "w9"]);
  assert.deepEqual(r.orphans, ["w9"]);
  assert.ok(!r.forget.includes("w9"), "orphans are reported, never reaped");
});

test("empty inputs classify cleanly in both directions", () => {
  assert.deepEqual(classifySession({}, []), { adopt: [], forget: [], orphans: [] });
  assert.deepEqual(classifySession({}, ["w5"]).orphans, ["w5"]);
  assert.deepEqual(classifySession({ w5: { cwd: "/c" } }, []).forget, ["w5"]);
});

test("classification is pure — the inputs are not mutated", () => {
  const known = { w1: { cwd: "/a" } };
  const live = ["w1", "w2"];
  classifySession(known, live);
  assert.deepEqual(Object.keys(known), ["w1"]);
  assert.deepEqual(live, ["w1", "w2"]);
});
