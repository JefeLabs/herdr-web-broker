import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
