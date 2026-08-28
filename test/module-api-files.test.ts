import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildApi } from "../src/module-api.js";
import { tmpDir } from "./util.js";

function withCwd(cwd: string, granted: string[] = ["files"]) {
  const deps = { index: { get: () => ({ cwd }) } } as never;
  return buildApi({
    moduleId: "m1",
    granted: granted as never,
    deps,
    session: "default",
    instance: "runtime",
    events: { on() {} } as never,
    log: () => {},
    audit: { record: () => {} },
  }).api;
}

test("files is absent when ungranted", () => {
  assert.equal(withCwd(tmpDir(), []).files, undefined);
});

test("read and write round-trip inside the workspace", async () => {
  const cwd = tmpDir();
  const api = withCwd(cwd);
  await api.files!.write("w1", "notes/a.txt", "hello\n");
  assert.equal(await api.files!.read("w1", "notes/a.txt"), "hello\n");
  assert.equal(readFileSync(join(cwd, "notes/a.txt"), "utf8"), "hello\n");
});

test("append adds rather than truncating", async () => {
  const api = withCwd(tmpDir());
  await api.files!.write("w1", "log.txt", "one\n");
  await api.files!.write("w1", "log.txt", "two\n", { append: true });
  assert.equal(await api.files!.read("w1", "log.txt"), "one\ntwo\n");
});

test("an ABSOLUTE path is rejected at the boundary, not normalized", async () => {
  const api = withCwd(tmpDir());
  await assert.rejects(() => api.files!.read("w1", "/etc/passwd"), /absolute/);
});

test("a ../ escape is rejected", async () => {
  const api = withCwd(tmpDir());
  await assert.rejects(() => api.files!.write("w1", "../outside.txt", "x"), /escapes/);
});

test("a SYMLINKED directory cannot be written through", async () => {
  const cwd = tmpDir();
  const outside = tmpDir();
  symlinkSync(outside, join(cwd, "escape"));
  const api = withCwd(cwd);
  await assert.rejects(() => api.files!.write("w1", "escape/pwned.txt", "x"), /escapes/);
});

test("a sibling directory sharing a prefix is NOT inside the workspace", async () => {
  // <cwd>-evil must not slip past a naive startsWith check.
  const cwd = tmpDir();
  const evil = cwd + "-evil";
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(evil, "x.txt"), "secret");
  const api = withCwd(cwd);
  await assert.rejects(() => api.files!.read("w1", `../${basename(evil)}/x.txt`), /escapes/);
});

test("list returns entries relative to the workspace", async () => {
  const cwd = tmpDir();
  mkdirSync(join(cwd, "d"), { recursive: true });
  writeFileSync(join(cwd, "d", "one.txt"), "1");
  const api = withCwd(cwd);
  assert.deepEqual(await api.files!.list("w1", "d"), ["one.txt"]);
});

test("a workspace the index does not know is refused, not silently rooted somewhere", async () => {
  const deps = { index: { get: () => undefined } } as never;
  const api = buildApi({
    moduleId: "m1",
    granted: ["files"] as never,
    deps,
    session: "default",
    instance: "runtime",
    events: { on() {} } as never,
    log: () => {},
    audit: { record: () => {} },
  }).api;
  await assert.rejects(() => api.files!.read("nope", "a.txt"), /no recorded cwd/);
});
