import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { oneShotRpc } from "../src/local-attach.js";

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "hwb-"));
}

export async function waitFor(fn: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

/** Is a herdr actually LISTENING on this path? Asks it, rather than trusting
 * the filesystem.
 *
 * live-smoke used to gate on existsSync, and a unix socket file outlives the
 * process that bound it — a stale one from a herdr that exited days ago passes
 * that check forever. The test then ran against a dead endpoint, adopted no
 * session, and failed on `sessions.length >= 1`: a real assertion failure with
 * an environmental cause, reported as if the broker were broken.
 *
 * `ping` is the same probe LocalHerdr adopts an endpoint with, so "live" here
 * means exactly what it means to the daemon. Every failure mode collapses to
 * false — absent path, regular file, socket with nothing accepting, a herdr too
 * wedged to answer in time — because they are the same decision: do not run.
 */
export async function herdrAnswers(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  return oneShotRpc(socketPath, "ping", {}, timeoutMs).then(
    () => true,
    () => false,
  );
}

/** Run git synchronously in test setup; throw loudly on failure. */
export function sh(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A real repo with one committed file (a.txt = "one\n"). -b main pins the
 * branch name regardless of the machine's init.defaultBranch. */
export function scratchRepo(dir = tmpDir()): string {
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.email", "t@test"]);
  sh(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-qm", "init"]);
  return dir;
}
