import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliProfiles } from "../src/cli-profiles.js";
import { prepareWorkspace, trustProject } from "../src/prepare-workspace.js";
import { tmpDir } from "./util.js";

const claude = () => new CliProfiles().get("claude")!;

function readCfg(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as Record<string, unknown>;
}

function projects(dir: string): Record<string, Record<string, unknown>> {
  return (readCfg(dir).projects ?? {}) as Record<string, Record<string, unknown>>;
}

test("claude: writes a broker-owned config dir and returns its env var", () => {
  const state = tmpDir();
  const env = prepareWorkspace(claude(), state);
  const dir = env.CLAUDE_CONFIG_DIR;
  assert.ok(dir && dir.startsWith(state), "the config dir lives under the broker's state dir");
  assert.equal(readCfg(dir).hasCompletedOnboarding, true);
  // the trust dialog is a safety control being bypassed here — these
  // permissions ARE the protection, not incidental hardening.
  assert.equal(statSync(dir).mode & 0o777, 0o700, "config dir is owner-only");
  assert.equal(statSync(join(dir, ".claude.json")).mode & 0o777, 0o600, "config file is owner-only");
});

test("trust is written per PROJECT, not at the top level", () => {
  // The bug WT-11's first run found (2026-08-30, claude 2.1.251): the
  // profile wrote a top-level hasTrustDialogAccepted, the CLI read the
  // broker-owned dir, and the dialog appeared anyway — because trust is
  // keyed by path under `projects`. The old test asserted the top-level
  // key and passed, proving only that the broker WROTE it. This asserts
  // the shape the CLI actually reads.
  const state = tmpDir();
  const dir = prepareWorkspace(claude(), state).CLAUDE_CONFIG_DIR;
  assert.equal(readCfg(dir).hasTrustDialogAccepted, undefined, "a top-level copy answers nothing and must not be shipped");

  const cwd = tmpDir();
  trustProject(claude(), state, cwd);
  assert.equal(projects(dir)[cwd]?.hasTrustDialogAccepted, true);
});

test("trust is written for the realpath too, since the CLI resolves the path it is given", () => {
  // macOS hands out /var/folders/... and the CLI reports /private/var/... —
  // WT-11's dialog named the resolved form. Writing only the literal path
  // leaves a spawn hanging at a prompt nobody is watching.
  const state = tmpDir();
  const dir = prepareWorkspace(claude(), state).CLAUDE_CONFIG_DIR;
  const cwd = tmpDir();
  const real = realpathSync(cwd);
  trustProject(claude(), state, cwd);
  assert.equal(projects(dir)[cwd]?.hasTrustDialogAccepted, true, "the literal cwd is trusted");
  assert.equal(projects(dir)[real]?.hasTrustDialogAccepted, true, "the resolved cwd is trusted");
});

test("a second cwd ACCUMULATES rather than replacing the first", () => {
  // The regression the wholesale rewrite caused: entries have to survive
  // each other, or every spawn un-trusts every directory before it.
  const state = tmpDir();
  const dir = prepareWorkspace(claude(), state).CLAUDE_CONFIG_DIR;
  const a = tmpDir();
  const b = tmpDir();
  trustProject(claude(), state, a);
  trustProject(claude(), state, b);
  assert.equal(projects(dir)[a]?.hasTrustDialogAccepted, true, "the first cwd survives the second");
  assert.equal(projects(dir)[b]?.hasTrustDialogAccepted, true);
});

test("re-preparing preserves state the CLI wrote for itself", () => {
  // claude writes machineID, userID, firstStartVersion and migration flags
  // into this file on first run. The wholesale rewrite reset all of it on
  // every spawn, and would have wiped the trust entries above with it.
  const state = tmpDir();
  const dir = prepareWorkspace(claude(), state).CLAUDE_CONFIG_DIR;
  const file = join(dir, ".claude.json");
  const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  written.machineID = "cli-written";
  written.migrationVersion = 13;
  writeFileSync(file, JSON.stringify(written));

  trustProject(claude(), state, tmpDir());
  prepareWorkspace(claude(), state);

  const after = readCfg(dir);
  assert.equal(after.machineID, "cli-written", "the CLI's own state survives a re-prepare");
  assert.equal(after.migrationVersion, 13);
  assert.equal(after.hasCompletedOnboarding, true, "and the broker's own keys are still applied");
});

test("a kind with no prepare block returns no env and writes nothing", () => {
  const state = tmpDir();
  assert.deepEqual(prepareWorkspace(new CliProfiles().get("codex")!, state), {});
  trustProject(new CliProfiles().get("codex")!, state, tmpDir());
  assert.equal(existsSync(join(state, "cli-config")), false);
});

test("re-preparing is idempotent and does not clobber an existing dir", () => {
  const state = tmpDir();
  const a = prepareWorkspace(claude(), state);
  const before = readFileSync(join(a.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8");
  const b = prepareWorkspace(claude(), state);
  assert.deepEqual(a, b);
  assert.equal(readFileSync(join(b.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8"), before, "bytes unchanged, not just the returned env");
});

test("re-trusting the same cwd is idempotent", () => {
  const state = tmpDir();
  const dir = prepareWorkspace(claude(), state).CLAUDE_CONFIG_DIR;
  const cwd = tmpDir();
  trustProject(claude(), state, cwd);
  const before = readFileSync(join(dir, ".claude.json"), "utf8");
  trustProject(claude(), state, cwd);
  assert.equal(readFileSync(join(dir, ".claude.json"), "utf8"), before);
});
