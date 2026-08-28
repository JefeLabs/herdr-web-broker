import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadModules, type LoadContext } from "../src/module-loader.js";
import { tmpDir } from "./util.js";

function ctx(): LoadContext {
  return {
    deps: { index: { get: () => ({ cwd: "/tmp" }) } } as never,
    session: "default",
    instance: "runtime",
    events: { on() {} } as never,
    log: () => {},
    audit: { record: () => {} },
  };
}

function writeModule(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

test("a well-formed module loads and its routes are collected", async () => {
  const dir = tmpDir();
  const p = writeModule(
    dir,
    "ok.js",
    `export default { id: "ok", abi: 1, capabilities: ["files"],
       register(api) { api.route("GET", "/ping", async () => ({ pong: true })); } };`,
  );
  const loaded = await loadModules([{ path: p, capabilities: ["files"] }], ctx());
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "ok");
  assert.deepEqual(loaded[0].granted, ["files"]);
  assert.equal(loaded[0].routes.length, 1);
  assert.equal(loaded[0].error, undefined);
});

test("an ABI mismatch is REFUSED with both numbers named", async () => {
  const dir = tmpDir();
  const p = writeModule(dir, "old.js", `export default { id: "old", abi: 99, capabilities: [], register() {} };`);
  const loaded = await loadModules([{ path: p, capabilities: [] }], ctx());
  assert.match(loaded[0].error!, /abi/i);
  assert.match(loaded[0].error!, /99/);
  assert.match(loaded[0].error!, /\b1\b/);
  assert.equal(loaded[0].routes.length, 0);
});

test("a module throwing at register() is contained — the loader still returns", async () => {
  const dir = tmpDir();
  const p = writeModule(
    dir,
    "boom.js",
    `export default { id: "boom", abi: 1, capabilities: [], register() { throw new Error("kaboom"); } };`,
  );
  const loaded = await loadModules([{ path: p, capabilities: [] }], ctx());
  assert.match(loaded[0].error!, /kaboom/);
});

test("a module that fails to IMPORT is contained too", async () => {
  const loaded = await loadModules([{ path: "/nonexistent/nope.js", capabilities: [] }], ctx());
  assert.equal(loaded.length, 1);
  assert.ok(loaded[0].error);
});

test("a module with no default export is refused, not crashed on", async () => {
  const dir = tmpDir();
  const p = writeModule(dir, "nodefault.js", `export const something = 1;`);
  const loaded = await loadModules([{ path: p, capabilities: [] }], ctx());
  assert.match(loaded[0].error!, /default export/);
});

test("a duplicate id refuses the SECOND and keeps the first", async () => {
  const dir = tmpDir();
  const a = writeModule(dir, "a.js", `export default { id: "dup", abi: 1, capabilities: [], register() {} };`);
  const b = writeModule(dir, "b.js", `export default { id: "dup", abi: 1, capabilities: [], register() {} };`);
  const loaded = await loadModules(
    [
      { path: a, capabilities: [] },
      { path: b, capabilities: [] },
    ],
    ctx(),
  );
  assert.equal(loaded[0].error, undefined);
  assert.match(loaded[1].error!, /duplicate/i);
});

test("an UNKNOWN capability name refuses the module rather than dropping it", async () => {
  const dir = tmpDir();
  const p = writeModule(dir, "typo.js", `export default { id: "t", abi: 1, capabilities: ["filez"], register() {} };`);
  const loaded = await loadModules([{ path: p, capabilities: ["filez"] }], ctx());
  assert.match(loaded[0].error!, /filez/);
});

test("one broken module does not prevent a good one loading — degrade, never throw", async () => {
  const dir = tmpDir();
  const bad = writeModule(dir, "bad.js", `export default { id: "bad", abi: 42, capabilities: [], register() {} };`);
  const good = writeModule(
    dir,
    "good.js",
    `export default { id: "good", abi: 1, capabilities: [],
       register(api) { api.route("GET", "/g", async () => ({})); } };`,
  );
  const loaded = await loadModules(
    [
      { path: bad, capabilities: [] },
      { path: good, capabilities: [] },
    ],
    ctx(),
  );
  assert.ok(loaded[0].error);
  assert.equal(loaded[1].error, undefined);
  assert.equal(loaded[1].routes.length, 1);
});

test("the grant a module RECEIVES is the intersection, not what it asked for", async () => {
  const dir = tmpDir();
  const p = writeModule(
    dir,
    "greedy.js",
    `export default { id: "greedy", abi: 1, capabilities: ["files", "agents", "rpc"], register() {} };`,
  );
  const loaded = await loadModules([{ path: p, capabilities: ["files"] }], ctx());
  assert.deepEqual(loaded[0].granted, ["files"], "the operator's list narrows the module's ask");
});
