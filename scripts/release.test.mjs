import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverPackages,
  orderByDependencies,
  classifyLookup,
  planRelease,
  publishAll,
} from "./release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @returns {import("./release.mjs").PkgState} */
const pkg = (name, status, deps = {}) => ({
  name,
  dir: `packages/${name.split("-").pop()}`,
  version: "0.2.0",
  deps,
  status,
});

// ---------------------------------------------------------------- discovery

test("discovers exactly the publishable workspaces", () => {
  const names = discoverPackages(ROOT).map((p) => p.name);
  assert.deepEqual(names.sort(), [
    "@jefelabs/herdr-broker-client",
    "@jefelabs/herdr-broker-module",
    "@jefelabs/herdr-broker-react",
    "@jefelabs/herdr-broker-ui",
  ]);
});

test("discovery skips private packages and dirs with no package.json", () => {
  const names = discoverPackages(ROOT).map((p) => p.name);
  assert.ok(!names.includes("@jefelabs/herdr-demo-web"), "demo-web is private");
  assert.equal(names.length, 4, "demo-copilot has no package.json at all");
});

// ---------------------------------------------------------------- ordering

test("orders dependencies before their dependents", () => {
  const unordered = [
    pkg("@jefelabs/herdr-broker-ui", "free", {
      "@jefelabs/herdr-broker-client": "^0.2.0",
      "@jefelabs/herdr-broker-react": "^0.2.0",
    }),
    pkg("@jefelabs/herdr-broker-react", "free", { "@jefelabs/herdr-broker-client": "^0.2.0" }),
    pkg("@jefelabs/herdr-broker-client", "free"),
    pkg("@jefelabs/herdr-broker-module", "free"),
  ];
  const names = orderByDependencies(unordered).map((p) => p.name);
  assert.ok(
    names.indexOf("@jefelabs/herdr-broker-client") < names.indexOf("@jefelabs/herdr-broker-react"),
    "client must publish before react",
  );
  assert.ok(
    names.indexOf("@jefelabs/herdr-broker-react") < names.indexOf("@jefelabs/herdr-broker-ui"),
    "react must publish before ui",
  );
  assert.equal(names.length, 4);
});

test("ordering rejects a dependency cycle instead of looping forever", () => {
  const cyclic = [
    pkg("a", "free", { b: "^1.0.0" }),
    pkg("b", "free", { a: "^1.0.0" }),
  ];
  assert.throws(() => orderByDependencies(cyclic), /cycle/);
});

// ---------------------------------------------------------------- lookups

test("a 404 means the version is free", () => {
  assert.equal(classifyLookup({ status: 404 }, "0.2.0").status, "free");
});

test("a published version is taken", () => {
  const res = { status: 200, body: { versions: { "0.2.0": {} }, time: { "0.2.0": "2026-08-28T22:55:17.489Z" } } };
  const got = classifyLookup(res, "0.2.0");
  assert.equal(got.status, "taken");
  assert.match(got.detail, /2026-08-28/);
});

test("a package that exists but lacks this version is free", () => {
  const res = { status: 200, body: { versions: { "0.1.0": {} } } };
  assert.equal(classifyLookup(res, "0.2.0").status, "free");
});

test("a registry error is an error, never free", () => {
  assert.equal(classifyLookup({ status: 503 }, "0.2.0").status, "error");
  assert.equal(classifyLookup({ error: new Error("ECONNRESET") }, "0.2.0").status, "error");
});

// ---------------------------------------------------------------- the policy

test("all versions free: publish everything, in order", () => {
  const packages = [pkg("a", "free"), pkg("b", "free"), pkg("c", "free")];
  const plan = planRelease(packages);
  assert.equal(plan.action, "publish");
  assert.deepEqual(plan.publish.map((p) => p.name), ["a", "b", "c"]);
  assert.deepEqual(plan.taken, []);
});

test("a taken version aborts the whole release", () => {
  const packages = [pkg("a", "taken"), pkg("b", "free"), pkg("c", "free")];
  const plan = planRelease(packages);
  assert.equal(plan.action, "abort");
  assert.deepEqual(plan.taken.map((p) => p.name), ["a"]);
  assert.ok(plan.reason, "abort must explain itself");
});

test("--resume skips taken versions and publishes the rest", () => {
  const packages = [pkg("a", "taken"), pkg("b", "free"), pkg("c", "free")];
  const plan = planRelease(packages, { resume: true });
  assert.equal(plan.action, "publish");
  assert.deepEqual(plan.publish.map((p) => p.name), ["b", "c"]);
  assert.deepEqual(plan.taken.map((p) => p.name), ["a"]);
});

test("an all-taken abort does not suggest --resume, which would also abort", () => {
  const plan = planRelease([pkg("a", "taken"), pkg("b", "taken")]);
  assert.equal(plan.action, "abort");
  assert.ok(!/--resume/.test(plan.reason), `nothing is free, so --resume is not a way out: ${plan.reason}`);
});

test("a failed lookup aborts even under --resume", () => {
  const packages = [pkg("a", "error"), pkg("b", "free")];
  const plan = planRelease(packages, { resume: true });
  assert.equal(plan.action, "abort");
  assert.deepEqual(plan.errors.map((p) => p.name), ["a"]);
});

test("--resume with nothing left to publish is an abort, not a silent success", () => {
  const packages = [pkg("a", "taken"), pkg("b", "taken")];
  const plan = planRelease(packages, { resume: true });
  assert.equal(plan.action, "abort");
  assert.deepEqual(plan.publish, []);
});

// ---------------------------------------------------------------- publishing

test("publishes every planned package in order", () => {
  const seen = [];
  const run = (dir) => (seen.push(dir), { ok: true });
  const result = publishAll([pkg("a", "free"), pkg("b", "free")], { run });
  assert.equal(result.failed, null);
  assert.deepEqual(result.published, ["a", "b"]);
  assert.equal(seen.length, 2);
});

test("a mid-sequence failure reports what shipped and what did not", () => {
  const run = (dir) => ({ ok: !dir.endsWith("b"), detail: "npm publish exited 1" });
  const result = publishAll([pkg("a", "free"), pkg("b", "free"), pkg("c", "free")], { run });
  assert.deepEqual(result.published, ["a"]);
  assert.equal(result.failed, "b");
  assert.deepEqual(result.skipped, ["c"]);
});

test("a failure on the first package publishes nothing", () => {
  const result = publishAll([pkg("a", "free"), pkg("b", "free")], { run: () => ({ ok: false }) });
  assert.deepEqual(result.published, []);
  assert.equal(result.failed, "a");
  assert.deepEqual(result.skipped, ["b"]);
});
