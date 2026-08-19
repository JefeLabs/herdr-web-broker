import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.js";
import { tmpDir } from "./util.js";

/** Validates the two documented herdr-shape assumptions (mapAgentList,
 * mapHerdrEvent) against a real herdr server. Skips unless both a herdr
 * binary and a live default socket exist. */
test("live smoke: daemon attaches to a real herdr and serves truth", async (t) => {
  const which = spawnSync("herdr", ["--version"], { encoding: "utf8" });
  const socket = process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config/herdr/herdr.sock");
  if (which.status !== 0 || !existsSync(socket)) {
    return t.skip("no herdr binary or live socket");
  }
  const handle = (await startDaemon({
    configDir: tmpDir(),
    stateDir: tmpDir(),
    projectionDir: tmpDir(),
    configOverrides: { listen: "127.0.0.1:0", client_tokens: [{ name: "t", token: "tok" }] },
    herdrVersion: which.stdout.trim(),
  }))!;
  const sessions = (await (
    await fetch(`${handle.base}/parent/runtime/sessions`, {
      headers: { authorization: "Bearer tok" },
    })
  ).json()) as { sessions: { name: string }[] };
  assert.ok(sessions.sessions.length >= 1, "expected at least the default session");
  const rpc = await fetch(`${handle.base}/parent/runtime/sessions/${sessions.sessions[0].name}/rpc`, {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({ method: "ping" }),
  });
  assert.equal(rpc.status, 200);
  await handle.close();
});
