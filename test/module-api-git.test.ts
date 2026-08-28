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

test("raw denies destructive porcelain — those go through the audited verbs", async () => {
  const g = api(["git.read"], scratchRepo()).git!;
  await assert.rejects(() => g.raw("w1", ".", ["reset", "--hard"]), /not permitted/);
  await assert.rejects(() => g.raw("w1", ".", ["clean", "-fd"]), /not permitted/);
  await assert.rejects(() => g.raw("w1", ".", ["checkout", "main"]), /not permitted/);
});

test("raw denies push --force specifically, since push itself is allowed to read", async () => {
  const g = api(["git.read"], scratchRepo()).git!;
  await assert.rejects(() => g.raw("w1", ".", ["push", "--force"]), /not permitted/);
  await assert.rejects(() => g.raw("w1", ".", ["push", "-f", "origin"]), /not permitted/);
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
