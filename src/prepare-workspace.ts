import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliProfile } from "./cli-profiles.js";

/** Pre-answer a CLI's first-run trust dialog by materializing a
 * BROKER-OWNED config dir and pointing the CLI at it through the env, so
 * the user's real ~/.claude.json is never opened.
 *
 * The trust dialog is a safety control. Answering it in the user's global
 * config answers it for every future run of that CLI everywhere, including
 * runs the broker never started; scoping acceptance to this dir keeps the
 * blast radius inside the broker's own spawns.
 *
 * Kinds without a `prepare` block (agy, codex, copilot, opencode as of this
 * writing — their config formats are unverified) are a no-op: no env, no
 * directory. Idempotent — a second call for the same profile/stateDir sees
 * the directory already exists and rewrites the same file over itself. */
export function prepareWorkspace(profile: CliProfile, stateDir: string): Record<string, string> {
  const prep = profile.prepare;
  if (!prep) return {};
  const dir = join(stateDir, "cli-config", profile.kind);
  // mode on mkdirSync/writeFileSync only applies at creation and is subject
  // to umask; chmod after mirrors owners.ts's #write to guarantee the bits
  // regardless (spec: broker-owned secrets are owner-only, 0700/0600).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, prep.fileName);
  writeFileSync(file, JSON.stringify(prep.contents, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return { [prep.configDirEnv]: dir };
}
