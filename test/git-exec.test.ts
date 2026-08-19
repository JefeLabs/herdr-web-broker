import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError } from "../src/errors.js";
import { git, resolveRepo, validateRef } from "../src/git-exec.js";
import { scratchRepo, sh, tmpDir } from "./util.js";

test("git() returns stdout and maps failures to git_error", async () => {
  const repo = scratchRepo();
  assert.equal((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(), "main");
  await assert.rejects(git(repo, ["rev-parse", "--verify", "nope"]), (e: BrokerError) => e.code === "git_error");
});

test("validateRef accepts plain refs, rejects options and junk", () => {
  validateRef("main");
  validateRef("feat/x-1");
  validateRef("HEAD~2");
  for (const bad of ["-rf", "--exec=x", "a b", "", "x".repeat(129), "$(x)"]) {
    assert.throws(() => validateRef(bad), (e: BrokerError) => e.code === "bad_request", bad);
  }
});

test("resolveRepo: '-' is the workspace root; subdir repos resolve; escapes all read as unknown_repo", () => {
  const root = scratchRepo(); // cwd IS the repo
  assert.equal(resolveRepo(root, "-"), realpathSync(root));

  const multi = tmpDir(); // cwd holding one repo + one plain dir + an escape symlink
  mkdirSync(join(multi, "api"));
  scratchRepo(join(multi, "api"));
  mkdirSync(join(multi, "plain"));
  const outside = scratchRepo();
  symlinkSync(outside, join(multi, "sneaky"));
  assert.equal(resolveRepo(multi, "api"), realpathSync(join(multi, "api")));
  for (const bad of ["..", "../..", "plain", "ghost", "sneaky", "/etc"]) {
    assert.throws(() => resolveRepo(multi, bad), (e: BrokerError) => e.code === "unknown_repo", bad);
  }
});

test("resolveRepo: vanished cwd is unknown_workspace", () => {
  assert.throws(
    () => resolveRepo(join(tmpDir(), "never-created"), "-"),
    (e: BrokerError) => e.code === "unknown_workspace",
  );
});
