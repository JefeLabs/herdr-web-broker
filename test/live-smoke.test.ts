import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.js";
import { herdrAnswers, tmpDir } from "./util.js";

/** Proves the daemon can attach to a real herdr and serve requests over it
 * (connectivity), and — when the live instance actually has agents — that
 * mapAgentList's shape assumption (id/title/status ∈ working|blocked|idle)
 * holds against real data. It does not prove events map correctly (no live
 * status change is triggered) or that every herdr version behaves this way.
 * Skips unless both a herdr binary and a live default socket exist. */
test("live smoke: daemon attaches to a real herdr and serves truth", async (t) => {
  const which = spawnSync("herdr", ["--version"], { encoding: "utf8" });
  const socket = process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config/herdr/herdr.sock");
  // Liveness by asking, not by stat: a unix socket file outlives the process
  // that bound it, so existsSync kept a herdr that exited days ago looking
  // live and this test ran against a dead endpoint.
  if (which.status !== 0 || !(await herdrAnswers(socket))) {
    return t.skip("no herdr binary or no herdr answering on the socket");
  }
  const handle = (await startDaemon({
    configDir: tmpDir(),
    stateDir: tmpDir(),
    projectionDir: tmpDir(),
    configOverrides: { listen: "127.0.0.1:0", client_tokens: [{ name: "t", token: "tok" }] },
    herdrVersion: which.stdout.trim(),
  }))!;
  // Registered the moment the handle exists, not awaited at the end: a failing
  // assertion below skips straight past any trailing close(), and the daemon's
  // HTTP listener plus LocalHerdr's rescan interval then hold the event loop
  // open forever. node --test reports the failure and never exits, so ONE bad
  // assertion here stops the whole suite with no output saying why — which is
  // exactly what a stale herdr socket caused. t.after runs on every exit path.
  t.after(() => handle.close());
  const sessions = (await (
    await fetch(`${handle.base}/instances/runtime/sessions`, {
      headers: { authorization: "Bearer tok" },
    })
  ).json()) as { sessions: { name: string }[] };
  assert.ok(sessions.sessions.length >= 1, "expected at least the default session");
  const rpc = await fetch(`${handle.base}/instances/runtime/sessions/${sessions.sessions[0].name}/rpc`, {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({ method: "ping" }),
  });
  assert.equal(rpc.status, 200);

  const firstSession = sessions.sessions[0].name;
  const agentsRes = (await (
    await fetch(`${handle.base}/instances/runtime/sessions/${firstSession}/agents?fresh=1`, {
      headers: { authorization: "Bearer tok" },
    })
  ).json()) as { agents: { id: unknown; title: unknown; status: unknown }[] };
  assert.ok(Array.isArray(agentsRes.agents));
  for (const agent of agentsRes.agents) {
    assert.equal(typeof agent.id, "string");
    assert.equal(typeof agent.title, "string");
    assert.ok(["working", "blocked", "idle"].includes(agent.status as string));
  }

});
