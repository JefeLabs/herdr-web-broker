import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliProfile } from "./cli-profiles.js";

/** The directory prepareWorkspace writes to (or would write to) for this
 * profile — pure, no side effects. `configDirEnv` (CLAUDE_CONFIG_DIR,
 * COPILOT_HOME) doesn't just relocate the trust-dialog file; it relocates the
 * CLI'"'"'s WHOLE config dir, transcripts included — and for copilot that means
 * `session-store.db`, the store WT-5 reads, moves with it — so readTurnState (transcript.ts)
 * calls this too, to look for a broker-made spawn's transcript in the same
 * directory the CLI actually wrote it to, not the user's real $HOME.
 * Returns undefined for a kind with no `prepare` block — nothing is ever
 * redirected for it. */
export function configDirFor(profile: CliProfile, stateDir: string): string | undefined {
  return profile.prepare ? join(stateDir, "cli-config", profile.kind) : undefined;
}

/** Drop whole-line `//` comments so a JSONC config parses.
 *
 * copilot writes `// User settings belong in settings.json.` above the object
 * in `config.json`, which `JSON.parse` rejects — and the catch below treats an
 * unparseable file as replaceable, so without this every spawn would rewrite
 * the file and wipe both the CLI's accumulated state and every trust entry
 * earlier spawns added. That is the clobber WT-11 found in claude's prepare,
 * which stayed invisible until something had to survive a second spawn.
 *
 * Deliberately only WHOLE-LINE comments, never `//` mid-line: a trailing-
 * comment stripper has to understand string literals, and every trust entry
 * here is a path that can legitimately contain `//`. Dropping a line that
 * merely starts with the marker cannot corrupt a value. */
function stripLineComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/** Read-modify-write the broker-owned config file.
 *
 * MERGE, never overwrite. Two things live in this file that a wholesale
 * rewrite destroys. The CLI's own accumulated state: claude writes
 * machineID, userID, firstStartVersion and migration flags into it on
 * first run, and resetting those every spawn re-runs onboarding work the
 * CLI thought it had finished. And the per-directory trust entries, which
 * by definition ACCUMULATE — one per cwd the broker has spawned into.
 *
 * The original implementation rewrote the file from `contents` on every
 * spawn. That was invisible while the only key was one static top-level
 * flag and fatal the moment anything had to survive a second spawn.
 *
 * Deliberately NOT locked. Two concurrent spawns can lose one merge, which
 * is strictly better than the unconditional clobber this replaces, and a
 * lock here still would not cover the CLI's own writes to the same file
 * while it runs. */
function editConfig(dir: string, fileName: string, edit: (cfg: Record<string, unknown>) => void): void {
  // mode on mkdirSync/writeFileSync only applies at creation and is subject
  // to umask; chmod after mirrors owners.ts's #write to guarantee the bits
  // regardless (spec: broker-owned secrets are owner-only, 0700/0600).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, fileName);
  let cfg: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(stripLineComments(readFileSync(file, "utf8"))) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        cfg = parsed as Record<string, unknown>;
      }
    } catch {
      // A truncated or corrupt file is replaced rather than preserved: the
      // alternative is one bad write failing every future spawn.
    }
  }
  edit(cfg);
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Materialize a BROKER-OWNED config dir and point the CLI at it through
 * the env, so the user's real ~/.claude.json is never opened.
 *
 * Scoping matters: answering a first-run prompt in the user's global config
 * answers it for every future run of that CLI everywhere, including runs the
 * broker never started. Keeping it in a broker-owned dir keeps the blast
 * radius inside the broker's own spawns.
 *
 * This half must run BEFORE the pane exists, because the env var it returns
 * is injected at pane creation. The per-directory half cannot — see
 * trustProject.
 *
 * Kinds without a `prepare` block (agy, codex, opencode as of this writing —
 * their config formats are unverified) are a no-op: no env, no directory.
 * copilot LEFT that list 2026-09-01, once its format was actually read
 * rather than assumed. */
export function prepareWorkspace(profile: CliProfile, stateDir: string): Record<string, string> {
  const prep = profile.prepare;
  const dir = configDirFor(profile, stateDir);
  if (!prep || !dir) return {};
  editConfig(dir, prep.fileName, (cfg) => {
    Object.assign(cfg, prep.contents);
  });
  // Reset declared state files so the CLI starts fresh rather than offering
  // to resume something. Written unconditionally, not only when present: a
  // first spawn should leave the dir in the same state a later one will, so
  // the second spawn is not the one that behaves differently — which is the
  // whole failure this exists to prevent.
  for (const name of prep.resetJson ?? []) {
    const f = join(dir, name);
    writeFileSync(f, "{}\n", { mode: 0o600 });
    chmodSync(f, 0o600);
  }
  return { [prep.configDirEnv]: dir };
}

/** Pre-answer the CLI's per-DIRECTORY trust prompt for one cwd.
 *
 * Split from prepareWorkspace because the two halves have different timing:
 * the config-dir env must be known before the pane is created, while the
 * effective cwd is not known until after it. Mode C is the case that proves
 * it — `worktree.create` returns the checkout path, so the directory the
 * agent actually runs in does not exist when prepareWorkspace is called, and
 * an isolated checkout is a new path by construction, meaning EVERY mode-C
 * spawn faces the dialog.
 *
 * Writes both the given cwd and its realpath when they differ. The CLI keys
 * trust on the path IT resolves, and on macOS a /var/... cwd surfaces as
 * /private/var/... — observed directly in WT-11's dialog, which named the
 * realpath'd form. One redundant key costs nothing; a missed one costs a
 * spawn that hangs at a prompt nobody is watching. */
export function trustProject(profile: CliProfile, stateDir: string, cwd: string): void {
  const prep = profile.prepare;
  const dir = configDirFor(profile, stateDir);
  if (!prep || !dir || (!prep.perProject && !prep.trustedPaths)) return;
  const keys = new Set([cwd]);
  try {
    keys.add(realpathSync(cwd));
  } catch {
    // cwd may not exist yet or may be unreadable — the literal path is
    // still worth writing, so this is not a reason to skip the entry.
  }
  // The LIST shape (copilot's `trustedFolders`). Append-with-dedupe rather
  // than a key merge: a repeated spawn into one cwd must not grow the file
  // without bound, and the CLI's own membership test is an equality scan.
  if (prep.trustedPaths) {
    const key = prep.trustedPaths.key;
    editConfig(dir, prep.fileName, (cfg) => {
      const raw = cfg[key];
      const list = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
      for (const k of keys) if (!list.includes(k)) list.push(k);
      cfg[key] = list;
    });
    return;
  }
  const perProject = prep.perProject!;
  editConfig(dir, prep.fileName, (cfg) => {
    const raw = cfg.projects;
    const projects =
      raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    for (const key of keys) {
      const prior = projects[key];
      const existing =
        prior !== null && typeof prior === "object" && !Array.isArray(prior) ? (prior as Record<string, unknown>) : {};
      projects[key] = { ...existing, ...perProject };
    }
    cfg.projects = projects;
  });
}
