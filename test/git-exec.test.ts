import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError } from "../src/errors.js";
import { discoverRepos, foldTree, git, repoCheckout, repoCommit, repoDiff, repoLog, repoPush, repoTree, resolveRepo, validateRef } from "../src/git-exec.js";
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

test("discoverRepos: cwd-is-repo yields the single '.' entry with branch and dirty", async () => {
  const repo = scratchRepo();
  writeFileSync(join(repo, "a.txt"), "changed\n");
  const repos = await discoverRepos(repo);
  assert.equal(repos.length, 1);
  assert.deepEqual(repos[0], { name: repo.split("/").pop(), path: ".", branch: "main", dirty: true });
});

test("discoverRepos: shallow scan finds depth-1 and depth-2 repos, skips node_modules/hidden/plain dirs", async () => {
  const cwd = tmpDir();
  mkdirSync(join(cwd, "api"));
  scratchRepo(join(cwd, "api"));
  mkdirSync(join(cwd, "services", "web"), { recursive: true });
  scratchRepo(join(cwd, "services", "web"));
  mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
  scratchRepo(join(cwd, "node_modules", "dep")); // must NOT be found
  mkdirSync(join(cwd, ".hidden"));
  mkdirSync(join(cwd, "plain"));
  const repos = await discoverRepos(cwd);
  assert.deepEqual(repos.map((r) => r.path).sort(), ["api", "services/web"]);
  assert.equal(repos.every((r) => r.branch === "main" && r.dirty === false), true);
});

test("discoverRepos: unreadable cwd yields an empty list, not a crash", async () => {
  assert.deepEqual(await discoverRepos(join(tmpDir(), "nope")), []);
});

test("foldTree nests paths into dir/file nodes", () => {
  const tree = foldTree("api", ["a.txt", "src/index.ts", "src/lib/util.ts"]);
  assert.deepEqual(tree, {
    name: "api",
    type: "dir",
    children: [
      { name: "a.txt", type: "file" },
      {
        name: "src",
        type: "dir",
        children: [
          { name: "index.ts", type: "file" },
          { name: "lib", type: "dir", children: [{ name: "util.ts", type: "file" }] },
        ],
      },
    ],
  });
});

test("repoTree: tracked + untracked-not-ignored, never .git or ignored files", async () => {
  const repo = scratchRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "new.ts"), "x"); // untracked
  writeFileSync(join(repo, ".gitignore"), "secret.txt\n");
  writeFileSync(join(repo, "secret.txt"), "x"); // ignored — must not appear
  const { tree, truncated } = await repoTree(repo);
  const names = (tree.children ?? []).map((c) => c.name).sort();
  assert.deepEqual(names, [".gitignore", "a.txt", "src"]);
  assert.equal(truncated, false);
});

test("repoDiff: modified + untracked in status; unified diff covers staged and unstaged", async () => {
  const repo = scratchRepo();
  writeFileSync(join(repo, "a.txt"), "two\n"); // unstaged modify
  writeFileSync(join(repo, "new.txt"), "n\n"); // untracked
  const d = await repoDiff(repo);
  assert.equal(d.branch, "main");
  assert.deepEqual(
    d.status.sort((x, y) => x.path.localeCompare(y.path)),
    [{ path: "a.txt", state: "M" }, { path: "new.txt", state: "?" }],
  );
  assert.match(d.diff, /-one\n\+two/);
  assert.equal(d.diff.includes("new.txt"), false); // untracked listed, not inlined
  assert.equal(d.truncated, false);
});

test("repoDiff: renames don't corrupt the status parse (porcelain -z two-field entries)", async () => {
  const repo = scratchRepo();
  sh(repo, ["mv", "a.txt", "b.txt"]);
  const d = await repoDiff(repo);
  assert.equal(d.status.length, 1);
  assert.equal(d.status[0].state, "R");
  assert.equal(d.status[0].path, "b.txt");
});

test("repoDiff: ?base= diffs against that ref; bad refs are bad_request", async () => {
  const repo = scratchRepo();
  writeFileSync(join(repo, "a.txt"), "two\n");
  sh(repo, ["commit", "-aqm", "second"]);
  const d = await repoDiff(repo, "HEAD~1");
  assert.match(d.diff, /-one\n\+two/);
  await assert.rejects(repoDiff(repo, "-rf"), (e: BrokerError) => e.code === "bad_request");
});

test("repoDiff: oversized diffs truncate under the cap with full_bytes reported", async () => {
  const repo = scratchRepo();
  writeFileSync(join(repo, "a.txt"), "x".repeat(1_100_000) + "\n");
  const d = await repoDiff(repo);
  assert.equal(d.truncated, true);
  assert.ok(Buffer.byteLength(d.diff) <= 768 * 1024);
  assert.ok((d.full_bytes ?? 0) > 1_000_000);
});

test("repoCommit stages and commits; a clean tree reports clean instead of erroring", async () => {
  const repo = scratchRepo();
  writeFileSync(join(repo, "new.txt"), "hi\n");
  const out = await repoCommit(repo, { message: "vibe: add new.txt" });
  assert.equal(out.committed, true);
  assert.match(String(out.commit), /^[0-9a-f]{7,40}$/);
  assert.equal(out.subject, "vibe: add new.txt");
  assert.equal(out.branch, "main");
  const again = await repoCommit(repo, { message: "nothing here" });
  assert.deepEqual(again, { committed: false, clean: true });
});

test("repoCommit: explicit author wins; identity falls back when no config exists anywhere", async () => {
  const repo = scratchRepo();
  writeFileSync(join(repo, "a.txt"), "x\n");
  const custom = await repoCommit(repo, { message: "m", author: { name: "Vibe", email: "v@x.dev" } });
  assert.equal(custom.committed, true);
  assert.match(await git(repo, ["log", "-1", "--format=%an <%ae>"]), /Vibe <v@x\.dev>/);

  // hide global/system config so the fallback branch is deterministic
  const bare = tmpDir();
  sh(bare, ["init", "-q", "-b", "main"]);
  writeFileSync(join(bare, "b.txt"), "y\n");
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  try {
    const out = await repoCommit(bare, { message: "fallback" });
    assert.equal(out.committed, true);
    assert.match(await git(bare, ["log", "-1", "--format=%an <%ae>"]), /herdr-web-broker <broker@herdr\.local>/);
  } finally {
    if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved.g;
    if (saved.s === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = saved.s;
  }
});

test("repoLog returns commits newest-first with subject/author/when", async () => {
  const repo = scratchRepo();
  writeFileSync(join(repo, "second.txt"), "2\n");
  await repoCommit(repo, { message: "second commit" });
  const log = await repoLog(repo, 10);
  assert.equal(log.length, 2);
  assert.equal(log[0].subject, "second commit");
  assert.equal(log[1].subject, "init");
  assert.ok(log[0].sha && log[0].author && log[0].when);
});

test("repoPush pushes to a local bare remote; a missing remote is git_error", async () => {
  const repo = scratchRepo();
  const bare = tmpDir();
  sh(bare, ["init", "-q", "--bare"]);
  sh(repo, ["remote", "add", "origin", bare]);
  const out = await repoPush(repo, {});
  assert.equal(out.pushed, true);
  assert.equal(out.remote, "origin");
  assert.equal(out.branch, "main");
  assert.equal((await git(bare, ["rev-parse", "main"])).trim(), (await git(repo, ["rev-parse", "main"])).trim());
  await assert.rejects(repoPush(repo, { remote: "ghost" }), (e: BrokerError) => e.code === "git_error");
});

test("repoCheckout switches and creates branches; option smuggling is rejected", async () => {
  const repo = scratchRepo();
  assert.deepEqual(await repoCheckout(repo, { ref: "feat/x", create: true }), { branch: "feat/x" });
  assert.deepEqual(await repoCheckout(repo, { ref: "main" }), { branch: "main" });
  await assert.rejects(repoCheckout(repo, { ref: "-rf" }), (e: BrokerError) => e.code === "bad_request");
});
