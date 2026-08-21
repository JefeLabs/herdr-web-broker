import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir, waitFor } from "./util.js";

async function boot() {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  await fake.listen();
  const stateDir = tmpDir();
  const handle = await startDaemon({
    configDir: tmpDir(),
    stateDir,
    configOverrides: { listen: "127.0.0.1:0", client_tokens: [{ name: "t", token: "tok" }] },
    localEndpoints: [{ session: "default", socketPath: fake.socketPath }],
    herdrVersion: "0.8.0-test",
    projectionDir: tmpDir(),
  });
  return { fake, stateDir, handle: handle! };
}

test("daemon boots, serves health and authed REST, and closes cleanly", async () => {
  const { fake, handle } = await boot();
  const health = await (await fetch(`${handle.base}/health`)).json();
  assert.equal(health.ok, true);
  const roll = await (
    await fetch(`${handle.base}/instances`, { headers: { authorization: "Bearer tok" } })
  ).json();
  assert.equal(roll.instances[0].instance, "runtime");
  await handle.close();
  await fake.close();
});

test("boot migrates plaintext config tokens to hashes; the original bearer still works", async () => {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  await fake.listen();
  const configDir = tmpDir();
  writeFileSync(
    join(configDir, "config.toml"),
    ['listen = "127.0.0.1:0"', "[[client_tokens]]", 'name = "cli"', 'token = "plain-secret"'].join("\n"),
  );
  const handle = await startDaemon({
    configDir,
    stateDir: tmpDir(),
    localEndpoints: [{ session: "default", socketPath: fake.socketPath }],
    herdrVersion: "0.8.0-test",
    projectionDir: tmpDir(),
  });
  try {
    // the plaintext token authenticates exactly as before…
    const roll = await fetch(`${handle!.base}/instances`, { headers: { authorization: "Bearer plain-secret" } });
    assert.equal(roll.status, 200);
    // …but at rest the config now holds only the hash
    const disk = readFileSync(join(configDir, "config.toml"), "utf8");
    assert.ok(!disk.includes("plain-secret"), "plaintext must be scrubbed from config.toml");
    assert.ok(disk.includes("token_hash"), "hash must be persisted");
  } finally {
    await handle!.close();
    await fake.close();
  }
});

test("second daemon against the same state dir yields to the healthy first", async () => {
  const { fake, stateDir, handle } = await boot();
  const second = await startDaemon({
    configDir: tmpDir(),
    stateDir,
    configOverrides: { listen: "127.0.0.1:0" },
    localEndpoints: [],
    herdrVersion: "0.8.0-test",
    projectionDir: tmpDir(),
  });
  assert.equal(second, undefined);
  await handle.close();
  await fake.close();
});

test("a stale lock is replaced", async () => {
  const { fake, stateDir, handle } = await boot();
  await handle.close(); // lock cleared on close; recreate a stale one by hand
  const { writeLock } = await import("../src/state.js");
  writeLock(stateDir, { pid: 999999, listen: "127.0.0.1:1" });
  const again = await startDaemon({
    configDir: tmpDir(),
    stateDir,
    configOverrides: { listen: "127.0.0.1:0" },
    localEndpoints: [],
    herdrVersion: "0.8.0-test",
    projectionDir: tmpDir(),
  });
  assert.ok(again);
  await again.close();
  await fake.close();
});

test("a failed boot (port already in use) stops the local attach it started", async () => {
  const { fake: fakeA, handle: handleA } = await boot();
  const fakeB = new FakeHerdr(join(tmpDir(), "hB.sock"));
  await fakeB.listen();

  await assert.rejects(
    () =>
      startDaemon({
        configDir: tmpDir(),
        stateDir: tmpDir(),
        configOverrides: { listen: `${handleA.host}:${handleA.port}` },
        localEndpoints: [{ session: "default", socketPath: fakeB.socketPath }],
        herdrVersion: "0.8.0-test",
        projectionDir: tmpDir(),
      }),
    (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, "EADDRINUSE");
      return true;
    },
  );
  // The failed daemon's LocalHerdr must have been stopped, not leaked.
  await waitFor(() => fakeB.connections === 0);

  await handleA.close();
  await fakeA.close();
  await fakeB.close();
});

test("tls config serves https when openssl is available", async (t) => {
  const which = spawnSync("openssl", ["version"]);
  if (which.status !== 0) return t.skip("no openssl");
  const dir = tmpDir();
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost",
  ]);
  const handle = await startDaemon({
    configDir: tmpDir(),
    stateDir: tmpDir(),
    configOverrides: { listen: "127.0.0.1:0", tls: { cert, key } },
    localEndpoints: [],
    herdrVersion: "0.8.0-test",
    projectionDir: tmpDir(),
  });
  assert.ok(handle!.base.startsWith("https://"));
  await handle!.close();
});
