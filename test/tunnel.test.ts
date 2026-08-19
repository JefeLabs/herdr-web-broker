import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Registry } from "../src/registry.js";
import { ChildrenStore } from "../src/state.js";
import { hashSecret } from "../src/auth.js";
import { TunnelHub, PROTO_VERSION } from "../src/tunnel.js";
import { attachUpgradeHandling } from "../src/ws-server.js";
import { loadConfig } from "../src/config.js";
import { tmpDir, waitFor } from "./util.js";

const HELLO = {
  type: "hello",
  name: "laptop",
  platform: "macos",
  herdr_version: "0.8.0",
  plugin_version: "0.1.0",
  proto: PROTO_VERSION,
  sessions: [{ name: "default", agents: [{ id: "a1", title: "claude", status: "idle" }] }],
};

async function setup() {
  const stateDir = tmpDir();
  const children = new ChildrenStore(stateDir);
  children.set("laptop", hashSecret("sekret"));
  const registry = new Registry();
  const hub = new TunnelHub();
  const server = createServer((_, res) => res.writeHead(404).end());
  attachUpgradeHandling(server, { children, hub, registry, config: loadConfig(tmpDir()) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { children, registry, hub, server, port };
}

function dial(port: number, name: string, secret: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/parent/enroll`, {
    headers: { "x-herdr-broker-name": name, "x-herdr-broker-secret": secret },
  });
}

test("enroll: wrong secret is refused before upgrade", async () => {
  const { server, port } = await setup();
  const ws = dial(port, "laptop", "wrong");
  const err = await new Promise<Error>((r) => ws.once("error", r));
  assert.match(err.message, /401/);
  server.close();
});

test("enroll: hello→welcome, snapshot lands, req/res round-trips, events apply, close = offline", async () => {
  const { registry, hub, server, port } = await setup();
  const ws = dial(port, "laptop", "sekret");
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify(HELLO));

  const welcome = JSON.parse(String(await new Promise((r) => ws.once("message", r))));
  assert.deepEqual(welcome, { type: "welcome", name: "laptop", proto: PROTO_VERSION });
  assert.ok(registry.get("laptop")?.online);
  assert.deepEqual(registry.counts("laptop"), { working: 0, blocked: 0, idle: 1 });

  // child answers a forwarded request (once — the next req, sent right before
  // ws.close() below, must go unanswered so the pending call rejects on close)
  ws.once("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type === "req") {
      assert.equal(frame.session, "default");
      assert.equal(frame.method, "agent.list");
      ws.send(JSON.stringify({ type: "res", id: frame.id, result: { agents: [] } }));
    }
  });
  const result = await hub.get("laptop")!.request("default", "agent.list", {});
  assert.deepEqual(result, { agents: [] });

  // child pushes a status event
  ws.send(
    JSON.stringify({
      type: "event",
      event: {
        kind: "agent_status",
        session: "default",
        agent: { id: "a1", title: "claude", status: "working" },
      },
    }),
  );
  await waitFor(() => registry.counts("laptop").working === 1);

  // pending requests fail and the instance goes offline when the tunnel drops
  const pending = hub.get("laptop")!.request("default", "agent.wait", {});
  ws.close();
  await assert.rejects(pending, (e: { code: string }) => e.code === "instance_offline");
  await waitFor(() => registry.get("laptop")!.online === false);
  assert.equal(hub.get("laptop"), undefined);
  server.close();
});

test("enroll: wrong proto is closed with proto_mismatch", async () => {
  const { server, port } = await setup();
  const ws = dial(port, "laptop", "sekret");
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ ...HELLO, proto: 99 }));
  const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
  assert.equal(code, 4001);
  server.close();
});

test("hub.disconnect severs the live tunnel (revocation path)", async () => {
  const { registry, hub, server, port } = await setup();
  const ws = dial(port, "laptop", "sekret");
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify(HELLO));
  await new Promise((r) => ws.once("message", r));
  hub.disconnect("laptop");
  await waitFor(() => registry.get("laptop")!.online === false);
  server.close();
});
