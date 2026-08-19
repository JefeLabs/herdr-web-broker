import { execFile } from "node:child_process";
import { existsSync, realpathSync, readdirSync } from "node:fs";
import { basename, join, sep } from "node:path";
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

export interface RepoInfo {
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
}

/** The workspace's repo set (spec §5): the cwd itself if it's a repo, else
 * a depth≤2 scan for .git — never descending into a found repo, hidden
 * dirs, or node_modules. Symlinked dirs are skipped (Dirent.isDirectory()
 * is false for symlinks), so the scan cannot walk out of the cwd. */
export async function discoverRepos(cwd: string): Promise<RepoInfo[]> {
  const hasGit = (d: string) => existsSync(join(d, ".git"));
  const found: { name: string; path: string }[] = [];
  try {
    if (hasGit(cwd)) {
      found.push({ name: basename(cwd), path: "." });
    } else {
      for (const e1 of readdirSync(cwd, { withFileTypes: true })) {
        if (!e1.isDirectory() || e1.name.startsWith(".") || e1.name === "node_modules") continue;
        const d1 = join(cwd, e1.name);
        if (hasGit(d1)) {
          found.push({ name: e1.name, path: e1.name });
          continue;
        }
        for (const e2 of readdirSync(d1, { withFileTypes: true })) {
          if (!e2.isDirectory() || e2.name.startsWith(".") || e2.name === "node_modules") continue;
          if (hasGit(join(d1, e2.name))) found.push({ name: e2.name, path: `${e1.name}/${e2.name}` });
        }
      }
    }
  } catch {
    return []; // cwd vanished or unreadable — an empty set, not a crash
  }
  const repos: RepoInfo[] = [];
  for (const r of found) {
    const dir = r.path === "." ? cwd : join(cwd, r.path);
    const branch = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).then((s) => s.trim()).catch(() => "unborn");
    const dirty = await git(dir, ["status", "--porcelain"]).then((s) => s.length > 0).catch(() => false);
    repos.push({ ...r, branch, dirty });
  }
  return repos;
}
