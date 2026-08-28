import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CAPABILITIES, isCapability, resolveGrant } from "../src/capabilities.js";

test("the capability set is the ABI's, and coarse on purpose", () => {
  assert.deepEqual(
    [...CAPABILITIES],
    ["git.read", "git.write", "files", "workspaces", "agents", "rpc", "events"],
  );
});

test("isCapability accepts only exact names", () => {
  assert.equal(isCapability("git.read"), true);
  assert.equal(isCapability("git"), false, "the parent is not itself a capability");
  assert.equal(isCapability("GIT.READ"), false, "names are case-sensitive");
  assert.equal(isCapability(""), false);
  assert.equal(isCapability(42), false);
});

test("the grant is the INTERSECTION — neither side alone can widen it", () => {
  const r = resolveGrant(["git.read", "files"], ["git.read", "agents"]);
  assert.deepEqual(r.granted, ["git.read"]);
  assert.deepEqual(r.unknown, []);
});

test("a module declaring nothing gets nothing, however generous the config", () => {
  assert.deepEqual(resolveGrant([], [...CAPABILITIES]).granted, []);
});

test("an operator granting nothing gets nothing, however greedy the module", () => {
  assert.deepEqual(resolveGrant([...CAPABILITIES], []).granted, []);
});

test("unknown names are COLLECTED, not silently dropped — from either side", () => {
  const r = resolveGrant(["git.read", "gti.read"], ["git.read", "filez"]);
  assert.deepEqual(r.granted, ["git.read"]);
  assert.deepEqual(r.unknown.sort(), ["filez", "gti.read"]);
});

test("granted preserves CAPABILITIES order, not caller order — stable for logs", () => {
  const r = resolveGrant(["events", "git.read"], ["events", "git.read"]);
  assert.deepEqual(r.granted, ["git.read", "events"]);
});

test("duplicates on either side do not duplicate the grant", () => {
  const r = resolveGrant(["files", "files"], ["files", "files"]);
  assert.deepEqual(r.granted, ["files"]);
});

test("packages/module's Capability union matches the broker's list exactly", () => {
  // The types package cannot import broker internals — third parties
  // compile against it — so the duplication is CHECKED rather than trusted.
  const src = readFileSync("packages/module/src/index.ts", "utf8");
  const start = src.indexOf("export type Capability");
  const union = src.slice(start, src.indexOf(";", start));
  const quoted = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(quoted.sort(), [...CAPABILITIES].sort(), "the two lists have diverged");
});
