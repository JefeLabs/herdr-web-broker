import test from "node:test";
import assert from "node:assert/strict";
import { buildApi } from "../src/module-api.js";
import { scratchRepo } from "./util.js";

function api(granted: string[], cwd: string) {
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

test("git is absent when ungranted", () => {
  assert.equal(api([], scratchRepo()).git, undefined);
});

test("git.read grants the readers and WITHHOLDS the writers", () => {
  const g = api(["git.read"], scratchRepo()).git!;
  assert.equal(typeof g.raw, "function");
  assert.equal(typeof g.log, "function");
  assert.equal(g.commit, undefined, "commit needs git.write");
  assert.equal(g.push, undefined, "push needs git.write");
});

test("git.write adds the writers on top", () => {
  const g = api(["git.read", "git.write"], scratchRepo()).git!;
  assert.equal(typeof g.commit, "function");
  assert.equal(typeof g.push, "function");
});

test("git.write alone grants nothing — the readers are the base", () => {
  assert.equal(api(["git.write"], scratchRepo()).git, undefined);
});

test("raw runs a real subcommand the broker never enumerated", async () => {
  const cwd = scratchRepo();
  const out = await api(["git.read"], cwd).git!.raw("w1", ".", ["log", "--oneline"]);
  assert.match(out, /init/);
});

test("raw REJECTS a string argv — there must be no shell to inject into", async () => {
  const g = api(["git.read"], scratchRepo()).git!;
  await assert.rejects(() => g.raw("w1", ".", "log --oneline" as never), /array/);
});

test("raw REFUSES a global option as argv[0] — `git -c alias.x='!sh'` is arbitrary execution", async () => {
  // Verified against real git: `git -c alias.pwn='!echo …' pwn` runs a
  // shell. The argv ARRAY stops metacharacter injection; it does nothing
  // when git itself spawns the shell. argv[0] must be a bare subcommand.
  const g = api(["git.read"], scratchRepo()).git!;
  await assert.rejects(() => g.raw("w1", ".", ["-c", "alias.pwn=!echo owned", "pwn"]), /must be a subcommand/);
  await assert.rejects(() => g.raw("w1", ".", ["-C", "/etc", "log"]), /must be a subcommand/);
  await assert.rejects(() => g.raw("w1", ".", ["--exec-path=/tmp/evil", "log"]), /must be a subcommand/);
  await assert.rejects(() => g.raw("w1", ".", ["--git-dir=/elsewhere", "log"]), /must be a subcommand/);
});

test("raw is READ-ONLY — an allowlist, because a denylist over git can never be complete", async () => {
  const g = api(["git.read"], scratchRepo()).git!;
  // The first draft denied reset/clean/checkout and left these open,
  // so a git.read grant could mutate freely.
  for (const sub of ["commit", "merge", "apply", "am", "update-ref", "branch", "config", "remote", "submodule"]) {
    await assert.rejects(() => g.raw("w1", ".", [sub, "--help"]), /read-only/, `'${sub}' must not be reachable`);
  }
  // And the ones the original denylist did cover.
  for (const sub of ["reset", "clean", "checkout", "rebase", "gc", "push", "fetch", "pull"]) {
    await assert.rejects(() => g.raw("w1", ".", [sub]), /read-only/, `'${sub}' must not be reachable`);
  }
});

test("raw denies exec-bearing options that survive as SUBCOMMAND options", async () => {
  const g = api(["git.read"], scratchRepo()).git!;
  await assert.rejects(() => g.raw("w1", ".", ["log", "--output=/tmp/x"]), /not permitted/);
  await assert.rejects(() => g.raw("w1", ".", ["grep", "--open-files-in-pager", "x"]), /not permitted/);
});

test("the read-only subcommands a real module needs still work", async () => {
  const cwd = scratchRepo();
  const g = api(["git.read"], cwd).git!;
  assert.match(await g.raw("w1", ".", ["log", "--oneline"]), /init/);
  assert.match(await g.raw("w1", ".", ["blame", "--porcelain", "a.txt"]), /a\.txt|author/i);
  assert.ok((await g.raw("w1", ".", ["rev-parse", "HEAD"])).trim().length >= 7);
  assert.match(await g.raw("w1", ".", ["ls-files"]), /a\.txt/);
});

test("raw rejects an empty argv rather than running bare git", async () => {
  const g = api(["git.read"], scratchRepo()).git!;
  await assert.rejects(() => g.raw("w1", ".", []), /empty/);
});

test("raw rejects a non-string element — argv must be strings end to end", async () => {
  const g = api(["git.read"], scratchRepo()).git!;
  await assert.rejects(() => g.raw("w1", ".", ["log", 5 as never]), /array/);
});

test("log reads through the vetted helper", async () => {
  const entries = (await api(["git.read"], scratchRepo()).git!.log("w1", ".")) as Array<{ subject?: string }>;
  assert.ok(Array.isArray(entries));
  assert.ok(entries.length >= 1);
});
