import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir } from "./util.js";

const CLI = join(process.cwd(), "dist/src/cli.js");

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

test("status / issue-secret / revoke against a live daemon", async () => {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  await fake.listen();
  const configDir = tmpDir();
  const stateDir = tmpDir();
  const handle = (await startDaemon({
    configDir,
    stateDir,
    configOverrides: { listen: "127.0.0.1:0" },
    localEndpoints: [{ session: "default", socketPath: fake.socketPath }],
    herdrVersion: "0.8.0-test",
    projectionDir: tmpDir(),
  }))!;
  const dirs = ["--config-dir", configDir, "--state-dir", stateDir];

  // Ensure daemon is fully ready by making a direct request first
  await fetch(`${handle.base}/health`);

  try {
    const status = run(["status", ...dirs]);
    assert.equal(status.status, 0);
    assert.equal(JSON.parse(status.stdout).running, true);

    const minted = run(["issue-secret", "--name", "laptop", ...dirs]);
    assert.equal(minted.status, 0);
    const parsed = JSON.parse(minted.stdout);
    assert.equal(parsed.name, "laptop");
    assert.ok(parsed.secret.length >= 40);

    const revoked = run(["revoke", "--name", "laptop", ...dirs]);
    assert.equal(revoked.status, 0);
  } finally {
    await handle.close();
    await fake.close();
  }
});

test("status reports not running when there is no daemon", () => {
  const out = run(["status", "--config-dir", tmpDir(), "--state-dir", tmpDir()]);
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).running, false);
});

test("pair writes [parent] into config.toml without a daemon", () => {
  const configDir = tmpDir();
  const out = run([
    "pair",
    "--address", "ws://parent.example:7591",
    "--secret", "sss",
    "--name", "laptop",
    "--config-dir", configDir,
    "--state-dir", tmpDir(),
  ]);
  assert.equal(out.status, 0);
  const toml = readFileSync(join(configDir, "config.toml"), "utf8");
  assert.match(toml, /\[parent\]/);
  assert.match(toml, /address = "ws:\/\/parent\.example:7591"/);
  assert.match(toml, /name = "laptop"/);
});

test("issue-secret without a daemon fails with guidance", () => {
  const out = run(["issue-secret", "--name", "x", "--config-dir", tmpDir(), "--state-dir", tmpDir()]);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /not running/);
});
