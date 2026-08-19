import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir } from "./util.js";

const CLI = join(process.cwd(), "dist/src/cli.js");

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args]);
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
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

  try {
    const status = await run(["status", ...dirs]);
    assert.equal(status.status, 0);
    assert.equal(JSON.parse(status.stdout).running, true);

    const minted = await run(["issue-secret", "--name", "laptop", ...dirs]);
    assert.equal(minted.status, 0);
    const parsed = JSON.parse(minted.stdout);
    assert.equal(parsed.name, "laptop");
    assert.ok(parsed.secret.length >= 40);

    const revoked = await run(["revoke", "--name", "laptop", ...dirs]);
    assert.equal(revoked.status, 0);
  } finally {
    await handle.close();
    await fake.close();
  }
});

test("status reports not running when there is no daemon", async () => {
  const out = await run(["status", "--config-dir", tmpDir(), "--state-dir", tmpDir()]);
  assert.equal(out.status, 0);
  assert.equal(JSON.parse(out.stdout).running, false);
});

test("pair writes [parent] into config.toml without a daemon", async () => {
  const configDir = tmpDir();
  const out = await run([
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

test("issue-secret without a daemon fails with guidance", async () => {
  const out = await run(["issue-secret", "--name", "x", "--config-dir", tmpDir(), "--state-dir", tmpDir()]);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /not running/);
});

test("flag without value errors with missing required message", async () => {
  const out = await run([
    "pair",
    "--address",
    "--secret", "sss",
    "--name", "x",
    "--config-dir", tmpDir(),
    "--state-dir", tmpDir(),
  ]);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /missing required --address/);
});

test("live daemon refusal on invalid input", async () => {
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

  try {
    const out = await run(["issue-secret", "--name", "bad/name", ...dirs]);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /daemon refused/);
  } finally {
    await handle.close();
    await fake.close();
  }
});
