import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliProfiles } from "../src/cli-profiles.js";
import { prepareWorkspace } from "../src/prepare-workspace.js";
import { tmpDir } from "./util.js";

test("claude: writes a broker-owned config dir and returns its env var", () => {
  const state = tmpDir();
  const env = prepareWorkspace(new CliProfiles().get("claude")!, state);
  const dir = env.CLAUDE_CONFIG_DIR;
  assert.ok(dir && dir.startsWith(state), "the config dir lives under the broker's state dir");
  const cfg = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as Record<string, unknown>;
  assert.equal(cfg.hasTrustDialogAccepted, true);
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
  const b = prepareWorkspace(p, state);
  assert.deepEqual(a, b);
});
