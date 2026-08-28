import test from "node:test";
import assert from "node:assert/strict";
import { matchModuleRoute } from "../src/module-routes.js";
import type { LoadedModule } from "../src/module-loader.js";

const loaded: LoadedModule[] = [
  {
    id: "blame",
    path: "x",
    granted: [],
    routes: [
      { method: "GET", path: "/repos/:repo/blame", handler: async () => ({}) },
      { method: "POST", path: "/refresh", handler: async () => ({}) },
    ],
  },
  { id: "broken", path: "y", granted: [], routes: [], error: "abi mismatch" },
];

test("matches a module route and extracts params", () => {
  const m = matchModuleRoute(loaded, "GET", ["modules", "blame", "repos", "myrepo", "blame"]);
  assert.equal(m?.mod.id, "blame");
  assert.deepEqual(m?.params, { repo: "myrepo" });
});

test("method is part of the match", () => {
  assert.equal(matchModuleRoute(loaded, "POST", ["modules", "blame", "repos", "r", "blame"]), undefined);
  assert.ok(matchModuleRoute(loaded, "POST", ["modules", "blame", "refresh"]));
});

test("a FAILED module's routes 404 — visible, not silently resolving elsewhere", () => {
  assert.equal(matchModuleRoute(loaded, "GET", ["modules", "broken", "anything"]), undefined);
});

test("an unknown module id does not match", () => {
  assert.equal(matchModuleRoute(loaded, "GET", ["modules", "nope", "x"]), undefined);
});

test("segment counts must match EXACTLY — no prefix matching", () => {
  assert.equal(matchModuleRoute(loaded, "GET", ["modules", "blame", "repos", "r"]), undefined);
  assert.equal(matchModuleRoute(loaded, "GET", ["modules", "blame", "repos", "r", "blame", "extra"]), undefined);
});

test("a param never spans a separator — one segment, one param", () => {
  const m = matchModuleRoute(loaded, "GET", ["modules", "blame", "repos", "a", "blame"]);
  assert.equal(m?.params.repo, "a");
});

test("non-module paths are not matched at all — core routes are untouched", () => {
  assert.equal(matchModuleRoute(loaded, "GET", ["instances", "runtime"]), undefined);
  assert.equal(matchModuleRoute(loaded, "GET", []), undefined);
  assert.equal(matchModuleRoute(loaded, "GET", ["modules"]), undefined);
});

test("an empty module list matches nothing rather than throwing", () => {
  assert.equal(matchModuleRoute([], "GET", ["modules", "blame", "refresh"]), undefined);
});
