import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { BrokerError } from "./errors.js";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1_048_576;
export const DIFF_CAP_BYTES = 768 * 1024;
export const TREE_CAP_ENTRIES = 20_000;

/** All git runs go through execFile — never a shell — with a hard timeout.
 * ENOENT (no git binary) and nonzero exits both surface as git_error. */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(new BrokerError("git_error", "git is not installed on this instance"));
        }
        reject(new BrokerError("git_error", `git ${args[0]} failed: ${String(stderr || err.message).slice(0, 400)}`));
      },
    );
  });
}

/** A base ref can never be smuggled in as a git option (spec §6). */
export function validateRef(ref: string): void {
  if (ref.startsWith("-") || !/^[A-Za-z0-9._/^~-]{1,128}$/.test(ref)) {
    throw new BrokerError("bad_request", "base must be a plain git ref");
  }
}

/** `repo` is the listing's `path`; "-" addresses the workspace-root repo.
 * Missing, escaping (.., absolute, symlink-out), and non-repo paths all
 * answer the same unknown_repo — no path-existence oracle (spec §6). */
export function resolveRepo(cwd: string, repo: string): string {
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    throw new BrokerError("unknown_workspace", "workspace cwd no longer exists");
  }
  let target = root;
  if (repo !== "-") {
    try {
      target = realpathSync(join(root, repo));
    } catch {
      throw new BrokerError("unknown_repo", `no repo '${repo}'`);
    }
    if (target !== root && !target.startsWith(root + sep)) {
      throw new BrokerError("unknown_repo", `no repo '${repo}'`);
    }
  }
  if (!existsSync(join(target, ".git"))) throw new BrokerError("unknown_repo", `no repo '${repo}'`);
  return target;
}
