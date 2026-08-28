import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CliProfiles } from "../src/cli-profiles.js";
import { prepareWorkspace } from "../src/prepare-workspace.js";
import { tmpDir } from "./util.js";

test("claude: writes a broker-owned config dir and returns its env var", () => {
  const state = tmpDir();
  const env = prepareWorkspace(new CliProfiles().get("claude")!, state);
  const dir = env.CLAUDE_CONFIG_DIR;
  assert.ok(dir && dir.startsWith(state), "the config dir lives under the broker's state dir");
  const file = join(dir, ".claude.json");
  const cfg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal(cfg.hasTrustDialogAccepted, true);
  // the trust dialog is a safety control being bypassed here — these
  // permissions ARE the protection, not incidental hardening.
  assert.equal(statSync(dir).mode & 0o777, 0o700, "config dir is owner-only");
  assert.equal(statSync(file).mode & 0o777, 0o600, "config file is owner-only");
});

test("a kind with no prepare block returns no env and writes nothing", () => {
  const state = tmpDir();
  assert.deepEqual(prepareWorkspace(new CliProfiles().get("codex")!, state), {});
  assert.equal(existsSync(join(state, "cli-config")), false);
});

test("re-preparing is idempotent and does not clobber an existing dir", () => {
  const state = tmpDir();
  const p = new CliProfiles().get("claude")!;
  const a = prepareWorkspace(p, state);
  const before = readFileSync(join(a.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8");
  const b = prepareWorkspace(p, state);
  assert.deepEqual(a, b);
  assert.equal(readFileSync(join(b.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8"), before, "bytes unchanged, not just the returned env");
});
