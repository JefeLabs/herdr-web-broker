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

// ── copilot: trust pre-answer via COPILOT_HOME ────────────────────────────

const copilot = () => new CliProfiles().get("copilot")!;
const copilotCfg = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;

test("copilot: prepare redirects COPILOT_HOME to a broker-owned dir", () => {
  // Measured 2026-09-01: COPILOT_HOME really does relocate copilot's config
  // dir (it wrote config.json, logs/ and session-store.db into one), and —
  // unlike claude with CLAUDE_CONFIG_DIR — copilot stays LOGGED IN through
  // the redirect. So containment costs nothing here and no credential
  // question stands in front of it.
  const state = tmpDir();
  const env = prepareWorkspace(copilot(), state);
  const dir = env.COPILOT_HOME;
  assert.ok(dir && dir.startsWith(state), "the config dir lives under the broker's state dir");
  assert.equal(statSync(dir).mode & 0o777, 0o700, "config dir is owner-only");
});

test("copilot: trust is an ARRAY of paths, and both cwd and realpath are written", () => {
  // copilot's own check is `trustedFolders.some(f => repoPathsEqual(f, cwd))`
  // — a flat list, not claude's map keyed by path. Same realpath reason as
  // claude: on macOS a /var/... cwd resolves to /private/var/...
  const state = tmpDir();
  const dir = prepareWorkspace(copilot(), state).COPILOT_HOME;
  const cwd = tmpDir();
  trustProject(copilot(), state, cwd);
  const trusted = copilotCfg(dir).trustedFolders as string[];
  assert.ok(Array.isArray(trusted), "trustedFolders is a list");
  assert.ok(trusted.includes(cwd), "the literal cwd is trusted");
  assert.ok(trusted.includes(realpathSync(cwd)), "and the path the CLI will resolve to");
});

test("copilot: a second cwd ACCUMULATES, and re-trusting does not duplicate", () => {
  const state = tmpDir();
  const dir = prepareWorkspace(copilot(), state).COPILOT_HOME;
  const a = tmpDir();
  const b = tmpDir();
  trustProject(copilot(), state, a);
  trustProject(copilot(), state, b);
  trustProject(copilot(), state, a);
  const trusted = copilotCfg(dir).trustedFolders as string[];
  assert.ok(trusted.includes(a) && trusted.includes(b), "both directories survive");
  assert.equal(
    trusted.filter((p) => p === a).length,
    1,
    "a repeated spawn into the same cwd must not grow the list without bound",
  );
});

test("copilot: a JSONC config is MERGED, not replaced", () => {
  // The trap this test exists for. copilot writes `// User settings belong in
  // settings.json.` at the top of config.json, and that does not parse as
  // strict JSON. editConfig's catch treats an unparseable file as replaceable,
  // so a strict parse here would rewrite the file every spawn and wipe both
  // copilot's own accumulated state AND every trustedFolders entry earlier
  // spawns added — the exact clobber WT-11 found in claude's prepare, which
  // was invisible until something had to survive a second spawn.
  const state = tmpDir();
  const dir = prepareWorkspace(copilot(), state).COPILOT_HOME;
  writeFileSync(
    join(dir, "config.json"),
    '// User settings belong in settings.json.\n// This file is managed automatically.\n' +
      '{\n  "firstLaunchAt": "2026-03-11T00:00:00.000Z",\n  "appTipShown": true,\n' +
      '  "trustedFolders": ["/already/trusted"]\n}\n',
  );
  const cwd = tmpDir();
  trustProject(copilot(), state, cwd);
  const cfg = copilotCfg(dir);
  assert.equal(cfg.firstLaunchAt, "2026-03-11T00:00:00.000Z", "the CLI's own state survives");
  assert.equal(cfg.appTipShown, true);
  const trusted = cfg.trustedFolders as string[];
  assert.ok(trusted.includes("/already/trusted"), "a folder copilot already trusted stays trusted");
  assert.ok(trusted.includes(cwd), "and the new one is added");
});
