import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { EnvRegistry } from "../src/env-registry.js";
import { LocalHerdr } from "../src/local-attach.js";
import { Registry } from "../src/registry.js";
import { ParentLink } from "../src/south.js";
import { WorkspaceIndex } from "../src/state.js";
import { PROTO_VERSION } from "../src/tunnel.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir } from "./util.js";

/** ParentLink's own heartbeat (spec §3: either side reaps a silently-dropped
 * tunnel) is hard to force a silent drop for deterministically. This covers
 * the mechanics instead: after a real enroll, the child's live ws answers a
 * server-initiated ping at the wire level (proving our new inbound-frame
 * guard didn't disturb control-frame handling), and stop() clears the
 * interval it started — a leaked (non-unref'd) handle here would hang this
 * file's node --test subprocess, so the suite exiting cleanly is itself
 * part of the proof. */
test("child heartbeat: answers a server-initiated ping after enroll; stop() clears its interval", async () => {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  await fake.listen();
  const registry = new Registry();
  const local = new LocalHerdr({
    registry,
    herdrVersion: "0.8.0-test",
    endpoints: [{ session: "default", socketPath: fake.socketPath }],
  });
  await local.start();

  // A bare WebSocketServer stands in for the parent daemon: just enough to
  // complete a real enroll and observe ParentLink's wire-level behavior.
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;

  let serverSideSocket: WebSocket | undefined;
  const helloReceived = new Promise<void>((resolve) => {
    wss.on("connection", (ws) => {
      serverSideSocket = ws;
      ws.once("message", (data) => {
        const hello = JSON.parse(String(data)) as { name: string };
        ws.send(JSON.stringify({ type: "welcome", name: hello.name, proto: PROTO_VERSION }));
        resolve();
      });
    });
  });

  const link = new ParentLink({
    address,
    secret: "sekret",
    name: "laptop",
    local,
    registry,
    remoteDeny: [],
    ops: { local, registry, index: new WorkspaceIndex(tmpDir()), env: new EnvRegistry({ stateDir: tmpDir() }) },
  });
  link.start();
  await helloReceived;

  // Server-initiated ping: the enrolled child's live ws must answer with a
  // pong at the protocol level.
  const ponged = new Promise<void>((resolve) => serverSideSocket!.once("pong", () => resolve()));
  serverSideSocket!.ping();
  await ponged;

  link.stop();
  serverSideSocket!.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  local.stop();
  await fake.close();
});
