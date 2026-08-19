import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../src/daemon.js";
import { encodeFrame, NdjsonDecoder } from "../src/ndjson.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir, waitFor } from "./util.js";

test("remote sessions project as local sockets that relay herdr NDJSON", { skip: process.platform === "win32" }, async () => {
  const fakeParent = new FakeHerdr(join(tmpDir(), "p.sock"));
  const fakeChild = new FakeHerdr(join(tmpDir(), "c.sock"));
  fakeChild.agents = [{ id: "c1", title: "codex", status: "idle" }];
  await fakeParent.listen();
  await fakeChild.listen();
  const projDir = tmpDir();

  let parent: DaemonHandle | undefined;
  let child: DaemonHandle | undefined;
  try {
    parent = (await startDaemon({
      configDir: tmpDir(),
      stateDir: tmpDir(),
      configOverrides: { listen: "127.0.0.1:0", client_tokens: [{ name: "t", token: "tok" }] },
      localEndpoints: [{ session: "default", socketPath: fakeParent.socketPath }],
      herdrVersion: "0.8.0-test",
      projectionDir: projDir,
    }))!;
    const minted = (await (
      await fetch(`${parent.base}/admin/children`, {
        method: "POST",
        headers: { "x-admin-token": parent.adminToken, "content-type": "application/json" },
        body: JSON.stringify({ name: "laptop" }),
      })
    ).json()) as { secret: string };
    child = (await startDaemon({
      configDir: tmpDir(),
      stateDir: tmpDir(),
      configOverrides: {
        listen: "127.0.0.1:0",
        parent: { address: `ws://127.0.0.1:${parent.port}`, secret: minted.secret, name: "laptop" },
      },
      localEndpoints: [{ session: "default", socketPath: fakeChild.socketPath }],
      herdrVersion: "0.8.0-test",
    }))!;

    const sockPath = join(projDir, "laptop", "default.sock");
    await waitFor(() => existsSync(sockPath));

    // stock herdr NDJSON against the projected socket
    const sock = connect(sockPath);
    sock.on("error", () => undefined);
    const dec = new NdjsonDecoder();
    const frames: unknown[] = [];
    sock.on("data", (c) => frames.push(...dec.push(c)));
    await new Promise((r) => sock.once("connect", r));
    sock.write(encodeFrame({ id: "p1", method: "agent.list", params: {} }));
    await waitFor(() => frames.length === 1);
    const reply = frames[0] as { id: string; result: { agents: { id: string }[] } };
    assert.equal(reply.id, "p1");
    assert.equal(reply.result.agents[0].id, "c1");
    sock.destroy();

    // offline → socket file removed
    await child.close();
    child = undefined;
    await waitFor(() => !existsSync(sockPath));
    // runtime is never projected
    assert.equal(existsSync(join(projDir, "runtime")), false);
  } finally {
    await child?.close();
    await parent?.close();
    await fakeParent.close();
    await fakeChild.close();
  }
});
