import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.js";
import { AgentIndex, ResumableIndex, WorkspaceIndex } from "../src/state.js";
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

// ── workspace.closed: push-based reap detection (roadmap 31f) ─────────────

test("a herdr-side reap the broker never called clears the row and announces it", async () => {
  // Roadmap 31(f). Item 32 closed the two paths where a BROKER call causes
  // the reap. This is the third: herdr closes a workspace on its own — a
  // herdr-side close, a crash — and no broker call is in the chain to notice.
  // Before this, the row sat there and nothing said so.
  const { fake, stateDir, handle } = await boot();
  try {
    const index = new WorkspaceIndex(stateDir);
    const agents = new AgentIndex(stateDir);
    index.set("default", "w1", { cwd: "/work", label: "ui" });
    agents.set("default", "w1:p1", { kind: "claude", sessionId: "sess-a", startedAt: 1 });

    const seen: Record<string, unknown>[] = [];
    handle.events.on("broker.workspace.reaped", (e) => void seen.push(e));

    await waitFor(() => fake.eventConnections > 0);
    fake.emitEvent("workspace.closed", { workspace_id: "w1" });
    await waitFor(() => index.get("default", "w1") === undefined);
    await handle.events.drain();

    assert.equal(index.get("default", "w1"), undefined, "the row for a reaped workspace is gone");
    assert.equal(
      new ResumableIndex(stateDir).get("default", "sess-a")?.cwd,
      "/work",
      "and its conversation was archived with the cwd, not silently dropped",
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].session, "default");
    assert.equal(seen[0].workspace_id, "w1");
    assert.equal(seen[0].indexed, true, "true means it was OURS and we cleared it");
  } finally {
    await handle.close();
    await fake.close();
  }
});

test("a reaped workspace the broker never indexed is announced but nothing is removed", async () => {
  // classifySession's discipline, kept on the push path: a workspace the
  // broker has no row for is someone else's work. There is nothing of ours
  // to clear, and `indexed:false` is how a client tells the two apart
  // instead of us inventing a removal.
  const { fake, stateDir, handle } = await boot();
  try {
    const index = new WorkspaceIndex(stateDir);
    index.set("default", "w1", { cwd: "/work" });

    const seen: Record<string, unknown>[] = [];
    handle.events.on("broker.workspace.reaped", (e) => void seen.push(e));

    await waitFor(() => fake.eventConnections > 0);
    fake.emitEvent("workspace.closed", { workspace_id: "w9" });
    await waitFor(() => seen.length > 0);
    await handle.events.drain();

    assert.equal(seen[0].workspace_id, "w9");
    assert.equal(seen[0].indexed, false, "false means an orphan — announced, never reaped");
    assert.equal(index.get("default", "w1")?.cwd, "/work", "an unrelated row is untouched");
  } finally {
    await handle.close();
    await fake.close();
  }
});

test("the reap event racing the close that caused it still archives exactly once", async () => {
  // The reason all three callers share reapWorkspaceRow. herdr emits
  // workspace.closed the instant it closes one, so the event lands INSIDE the
  // DELETE that triggered it — here, deliberately, from the close handler
  // itself. A handler that merely removed the row could win that race between
  // the herdr round trip and the archiving, take the cwd away, and make
  // resumable.record drop the conversation without a sound.
  const { fake, stateDir, handle } = await boot();
  try {
    const index = new WorkspaceIndex(stateDir);
    const agents = new AgentIndex(stateDir);
    index.set("default", "w1", { cwd: "/work", label: "team" });
    agents.set("default", "w1:p1", { kind: "claude", sessionId: "sess-a", startedAt: 1 });

    await waitFor(() => fake.eventConnections > 0);
    fake.handlers.set("workspace.close", () => {
      fake.emitEvent("workspace.closed", { workspace_id: "w1" });
      return { type: "ok" };
    });

    const res = await fetch(`${handle.base}/instances/runtime/sessions/default/workspaces/w1`, {
      method: "DELETE",
      headers: { authorization: "Bearer tok" },
    });
    assert.equal(res.status, 200);
    await waitFor(() => index.get("default", "w1") === undefined);
    await handle.events.drain();

    const archived = new ResumableIndex(stateDir).all("default");
    assert.equal(archived.length, 1, "archived exactly once, by whichever path got there first");
    assert.equal(archived[0].cwd, "/work", "with the cwd — the race did not strip it");
  } finally {
    await handle.close();
    await fake.close();
  }
});
