import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError } from "../src/errors.js";
import { discoverRepos, foldTree, git, repoCheckout, repoCommit, repoDiff, repoDiscard, repoLog, repoPull, repoPush, repoStash, repoStashList, repoStashPop, repoTree, resolveRepo, validateRef } from "../src/git-exec.js";
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

test("repoPull: fast-forward pulls cleanly; merge and rebase conflicts auto-abort and report files", async () => {
  const origin = scratchRepo();
  const parent = tmpDir();
  sh(parent, ["clone", "-q", origin, "w"]);
  const repo = join(parent, "w");
  sh(repo, ["config", "user.email", "c@test"]);
  sh(repo, ["config", "user.name", "c"]);

  // fast-forward: origin gains a commit, the clone pulls it
  writeFileSync(join(origin, "b.txt"), "new\n");
  sh(origin, ["add", "."]);
  sh(origin, ["commit", "-qm", "add b"]);
  const ff = await repoPull(repo, {});
  assert.equal(ff.pulled, true);
  assert.ok(readFileSync(join(repo, "b.txt"), "utf8").includes("new"));

  // divergence on a.txt: pull conflicts, auto-aborts, reports — the tree
  // returns to its pre-pull state (conflicts are agent work, spec choice)
  writeFileSync(join(origin, "a.txt"), "origin change\n");
  sh(origin, ["add", "."]);
  sh(origin, ["commit", "-qm", "origin a"]);
  writeFileSync(join(repo, "a.txt"), "local change\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-qm", "local a"]);
  const conflicted = await repoPull(repo, {});
  assert.equal(conflicted.pulled, false);
  assert.deepEqual(conflicted.conflicts, ["a.txt"]);
  assert.equal(sh(repo, ["status", "--porcelain"]).trim(), "", "merge aborted — no half-merged state survives");
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "local change\n");

  // the rebase flavor conflicts and aborts the same way
  const rebased = await repoPull(repo, { rebase: true });
  assert.equal(rebased.pulled, false);
  assert.deepEqual(rebased.conflicts, ["a.txt"]);
  assert.equal(sh(repo, ["status", "--porcelain"]).trim(), "");
});

test("repoDiscard: preview-then-confirm — the hash binds to the exact previewed state", async () => {
  const repo = scratchRepo();
  writeFileSync(join(repo, "a.txt"), "dirty\n");
  writeFileSync(join(repo, "u.txt"), "untracked\n");

  // preview touches nothing; untracked needs the explicit flag
  const preview = await repoDiscard(repo, { all: true });
  assert.deepEqual(preview.would_discard, ["a.txt"]);
  assert.ok(preview.confirm, "a confirm hash rides the preview");
  const withU = await repoDiscard(repo, { all: true, untracked: true });
  assert.deepEqual(withU.would_discard?.sort(), ["a.txt", "u.txt"]);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "dirty\n", "preview never touches the tree");

  // selection is mandatory — no implicit discard-everything
  await assert.rejects(
    () => repoDiscard(repo, {}),
    (e: BrokerError) => e.code === "bad_request",
  );

  // a stale confirm (tree changed since preview) refuses instead of guessing
  writeFileSync(join(repo, "second.txt"), "x\n");
  sh(repo, ["add", "second.txt"]);
  await assert.rejects(
    () => repoDiscard(repo, { all: true, confirm: preview.confirm }),
    (e: BrokerError) => e.code === "stale_confirm",
  );

  // a fresh confirm executes: tracked restored, staged-new unstaged, untracked kept
  const fresh = await repoDiscard(repo, { all: true });
  const done = await repoDiscard(repo, { all: true, confirm: fresh.confirm });
  assert.equal(done.discarded, true);
  assert.deepEqual(done.files?.sort(), ["a.txt", "second.txt"]);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "one\n");
  assert.equal(sh(repo, ["status", "--porcelain"]).includes("second.txt"), true, "unstaged, not deleted");
  assert.ok(readFileSync(join(repo, "u.txt"), "utf8"), "untracked survives without the flag");

  // path-scoped discard leaves the rest alone
  writeFileSync(join(repo, "a.txt"), "dirty again\n");
  const scoped = await repoDiscard(repo, { paths: ["a.txt"] });
  const scopedDone = await repoDiscard(repo, { paths: ["a.txt"], confirm: scoped.confirm });
  assert.deepEqual(scopedDone.files, ["a.txt"]);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "one\n");
});

test("repoStash: push/list/pop round-trip; a conflicted pop undoes itself and keeps the stash", async () => {
  const repo = scratchRepo();
  // a clean tree answers honestly instead of erroring
  const clean = await repoStash(repo, {});
  assert.deepEqual(clean, { stashed: false, clean: true });

  writeFileSync(join(repo, "a.txt"), "wip\n");
  const pushed = await repoStash(repo, { message: "my wip" });
  assert.equal(pushed.stashed, true);
  assert.equal(sh(repo, ["status", "--porcelain"]).trim(), "", "tree clean after stash");
  const listed = await repoStashList(repo);
  assert.equal(listed.length, 1);
  assert.ok(listed[0].subject.includes("my wip"));

  const popped = await repoStashPop(repo);
  assert.equal(popped.popped, true);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "wip\n");
  assert.equal((await repoStashList(repo)).length, 0);

  // conflict: stash the change, land a competing commit, pop
  const again = await repoStash(repo, { message: "wip2" });
  assert.equal(again.stashed, true);
  writeFileSync(join(repo, "a.txt"), "committed elsewhere\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-qm", "competing"]);
  const conflicted = await repoStashPop(repo);
  assert.equal(conflicted.popped, false);
  assert.deepEqual(conflicted.conflicts, ["a.txt"]);
  assert.equal(sh(repo, ["status", "--porcelain"]).trim(), "", "reset --merge undid the conflicted apply");
  assert.equal((await repoStashList(repo)).length, 1, "the stash survives a failed pop");
});
