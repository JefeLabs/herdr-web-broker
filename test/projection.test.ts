import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../src/daemon.js";
import { encodeFrame, NdjsonDecoder } from "../src/ndjson.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir, waitFor } from "./util.js";

interface Parts {
  fakeParent: FakeHerdr;
  fakeChild: FakeHerdr;
  parent: DaemonHandle;
  child: DaemonHandle;
  projDir: string;
  sockPath: string;
}

async function teardown(parts: Partial<Parts>): Promise<void> {
  // Unconditional cleanup — a leaked daemon or fake-herdr socket keeps the
  // node --test subprocess alive forever (see federation.test.ts).
  await parts.child?.close();
  await parts.parent?.close();
  await parts.fakeChild?.close();
  await parts.fakeParent?.close();
}

async function bootPair(): Promise<Parts> {
  const fakeParent = new FakeHerdr(join(tmpDir(), "p.sock"));
  const fakeChild = new FakeHerdr(join(tmpDir(), "c.sock"));
  fakeChild.agents = [{ pane_id: "c:p1", name: "codex", agent_status: "idle" }];
  await fakeParent.listen();
  await fakeChild.listen();
  const projDir = tmpDir();

  const partial: Partial<Parts> = { fakeParent, fakeChild, projDir };
  try {
    const parent = (await startDaemon({
      configDir: tmpDir(),
      stateDir: tmpDir(),
      configOverrides: { listen: "127.0.0.1:0", client_tokens: [{ name: "t", token: "tok" }] },
      localEndpoints: [{ session: "default", socketPath: fakeParent.socketPath }],
      herdrVersion: "0.8.0-test",
      projectionDir: projDir,
    }))!;
    partial.parent = parent;

    const minted = (await (
      await fetch(`${parent.base}/admin/children`, {
        method: "POST",
        headers: { "x-admin-token": parent.adminToken, "content-type": "application/json" },
        body: JSON.stringify({ name: "laptop" }),
      })
    ).json()) as { secret: string };

    const child = (await startDaemon({
      configDir: tmpDir(),
      stateDir: tmpDir(),
      configOverrides: {
        listen: "127.0.0.1:0",
        parent: { address: `ws://127.0.0.1:${parent.port}`, secret: minted.secret, name: "laptop" },
      },
      localEndpoints: [{ session: "default", socketPath: fakeChild.socketPath }],
      herdrVersion: "0.8.0-test",
      projectionDir: tmpDir(),
    }))!;
    partial.child = child;

    const sockPath = join(projDir, "laptop", "default.sock");
    await waitFor(() => existsSync(sockPath));
    partial.sockPath = sockPath;
    return partial as Parts;
  } catch (e) {
    await teardown(partial);
    throw e;
  }
}

/** Connects, waits for the socket to be ready, and collects decoded frames. */
async function dial(sockPath: string): Promise<{ sock: Socket; frames: unknown[] }> {
  const sock = connect(sockPath);
  sock.on("error", () => undefined);
  const dec = new NdjsonDecoder();
  const frames: unknown[] = [];
  sock.on("data", (c) => frames.push(...dec.push(c)));
  await new Promise((r) => sock.once("connect", r));
  return { sock, frames };
}

test(
  "remote sessions project as local sockets that relay herdr NDJSON",
  { skip: process.platform === "win32" },
  async () => {
    const parts = await bootPair();
    try {
      // stock herdr NDJSON against the projected socket
      const { sock, frames } = await dial(parts.sockPath);
      sock.write(encodeFrame({ id: "p1", method: "agent.list", params: {} }));
      await waitFor(() => frames.length === 1);
      const reply = frames[0] as { id: string; result: { agents: { pane_id: string }[] } };
      assert.equal(reply.id, "p1");
      assert.equal(reply.result.agents[0].pane_id, "c:p1");
      sock.destroy();

      // offline → socket file removed
      await parts.child.close();
      await waitFor(() => !existsSync(parts.sockPath));
      // runtime is never projected
      assert.equal(existsSync(join(parts.projDir, "runtime")), false);
    } finally {
      await teardown(parts);
    }
  },
);

test(
  "a malformed line destroys just that connection; the projected socket keeps serving",
  { skip: process.platform === "win32" },
  async () => {
    const parts = await bootPair();
    try {
      const garbage = await dial(parts.sockPath);
      let closed = false;
      garbage.sock.once("close", () => (closed = true));
      garbage.sock.write("not json\n");
      await waitFor(() => closed);

      // a fresh connection to the same projected socket still round-trips
      const { sock, frames } = await dial(parts.sockPath);
      sock.write(encodeFrame({ id: "p2", method: "agent.list", params: {} }));
      await waitFor(() => frames.length === 1);
      const reply = frames[0] as { id: string; result: { agents: { pane_id: string }[] } };
      assert.equal(reply.id, "p2");
      assert.equal(reply.result.agents[0].pane_id, "c:p1");
      sock.destroy();
    } finally {
      await teardown(parts);
    }
  },
);

test(
  "policy: a remote-denied method is refused at the projected socket without ever reaching the child",
  { skip: process.platform === "win32" },
  async () => {
    const parts = await bootPair();
    try {
      const { sock, frames } = await dial(parts.sockPath);
      sock.write(encodeFrame({ id: "d1", method: "server.stop", params: {} }));
      await waitFor(() => frames.length === 1);
      const reply = frames[0] as { id: string; error: { code: string } };
      assert.equal(reply.id, "d1");
      assert.equal(reply.error.code, "method_denied");
      assert.equal(parts.fakeChild.received.some((r) => r.method === "server.stop"), false);
      sock.destroy();
    } finally {
      await teardown(parts);
    }
  },
);

test(
  "a well-formed frame missing 'method' answers bad_request instead of timing out silently",
  { skip: process.platform === "win32" },
  async () => {
    const parts = await bootPair();
    try {
      const { sock, frames } = await dial(parts.sockPath);
      sock.write(encodeFrame({ id: "x" }));
      await waitFor(() => frames.length === 1);
      const reply = frames[0] as { id: string; error: { code: string } };
      assert.equal(reply.id, "x");
      assert.equal(reply.error.code, "bad_request");
      sock.destroy();
    } finally {
      await teardown(parts);
    }
  },
);
