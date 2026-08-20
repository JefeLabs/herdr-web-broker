import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import WebSocket from "ws";
import { startDaemon } from "../src/daemon.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir, waitFor } from "./util.js";

async function boot() {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  fake.agents = [{ pane_id: "w1:p1", name: "claude", agent_status: "working" }];
  await fake.listen();
  const handle = (await startDaemon({
    configDir: tmpDir(),
    stateDir: tmpDir(),
    configOverrides: { listen: "127.0.0.1:0", client_tokens: [{ name: "t", token: "tok" }] },
    localEndpoints: [{ session: "default", socketPath: fake.socketPath }],
    herdrVersion: "0.8.0-test",
    projectionDir: tmpDir(),
  }))!;
  return { fake, handle };
}

test("ws upgrade requires a bearer token", async () => {
  const { fake, handle } = await boot();
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/parent/ws`);
  const err = await new Promise<Error>((r) => ws.once("error", r));
  assert.match(err.message, /401/);
  await handle.close();
  await fake.close();
});

test("ws upgrade accepts ?token= for browser clients that cannot set headers", async () => {
  const { fake, handle } = await boot();
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/parent/ws?token=tok`);
  await new Promise((r) => ws.once("open", r));
  const reply = new Promise<Record<string, unknown>>((r) => ws.once("message", (d) => r(JSON.parse(String(d)))));
  ws.send(JSON.stringify({ id: "q1", method: "events.subscribe" }));
  assert.deepEqual(await reply, { id: "q1", result: { subscribed: true } });
  const bad = new WebSocket(`ws://127.0.0.1:${handle.port}/parent/ws?token=wrong`);
  const err = await new Promise<Error>((r) => bad.once("error", r));
  assert.match(err.message, /401/);
  ws.close();
  await handle.close();
  await fake.close();
});

test("ws upgrade accepts the token via Sec-WebSocket-Protocol (preferred over ?token= — no URL leakage)", async () => {
  const { fake, handle } = await boot();
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/parent/ws`, ["bearer", "tok"]);
  await new Promise((r) => ws.once("open", r));
  assert.equal(ws.protocol, "bearer", "server selects the 'bearer' subprotocol, never echoing the token");
  const reply = new Promise<Record<string, unknown>>((r) => ws.once("message", (d) => r(JSON.parse(String(d)))));
  ws.send(JSON.stringify({ id: "p1", method: "events.subscribe" }));
  assert.deepEqual(await reply, { id: "p1", result: { subscribed: true } });
  const bad = new WebSocket(`ws://127.0.0.1:${handle.port}/parent/ws`, ["bearer", "wrong"]);
  const err = await new Promise<Error>((r) => bad.once("error", r));
  assert.match(err.message, /401/);
  ws.close();
  await handle.close();
  await fake.close();
});

test("server pings keep idle client sockets alive through intermediaries", async () => {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  fake.agents = [];
  await fake.listen();
  const handle = (await startDaemon({
    configDir: tmpDir(),
    stateDir: tmpDir(),
    configOverrides: { listen: "127.0.0.1:0", client_tokens: [{ name: "t", token: "tok" }] },
    localEndpoints: [{ session: "default", socketPath: fake.socketPath }],
    herdrVersion: "0.8.0-test",
    projectionDir: tmpDir(),
    wsPingMs: 60,
  }))!;
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/parent/ws?token=tok`);
  await new Promise((r) => ws.once("open", r));
  let pings = 0;
  ws.on("ping", () => pings++);
  await waitFor(() => pings >= 2);
  assert.equal(ws.readyState, WebSocket.OPEN, "socket stays open across ping intervals");
  ws.close();
  await handle.close();
  await fake.close();
});

test("rpc over ws round-trips; events.subscribe acks; events stream unsolicited", async () => {
  const { fake, handle } = await boot();
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/parent/ws`, {
    headers: { authorization: "Bearer tok" },
  });
  await new Promise((r) => ws.once("open", r));
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));

  ws.send(
    JSON.stringify({ id: "1", instance: "runtime", session: "default", method: "agent.list" }),
  );
  await waitFor(() => frames.some((f) => f.id === "1"));
  const reply = frames.find((f) => f.id === "1") as { result: { agents: unknown[] } };
  assert.equal(reply.result.agents.length, 1);

  ws.send(
    JSON.stringify({ id: "2", instance: "runtime", session: "default", method: "events.subscribe" }),
  );
  await waitFor(() => frames.some((f) => f.id === "2"));
  assert.deepEqual((frames.find((f) => f.id === "2") as { result: unknown }).result, {
    subscribed: true,
  });

  fake.emitEvent("pane_agent_status_changed", {
    pane_id: "w1:p1",
    workspace_id: "w1",
    agent_status: "blocked",
    agent: "claude",
  });
  await waitFor(() =>
    frames.some(
      (f) =>
        (f.event as { type?: string; instance?: string } | undefined)?.type === "agent_status" &&
        (f.event as { instance: string }).instance === "runtime",
    ),
  );

  ws.send(JSON.stringify({ id: "3", instance: "ghost", session: "x", method: "ping" }));
  await waitFor(() => frames.some((f) => f.id === "3"));
  const errFrame = frames.find((f) => f.id === "3") as { error: { code: string } };
  assert.equal(errFrame.error.code, "unknown_instance");

  ws.close();
  await handle.close();
  await fake.close();
});

test("a malformed frame on an authed /parent/ws gets an error reply, not a crash — a fresh rpc still round-trips", async () => {
  const { fake, handle } = await boot();
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/parent/ws`, {
    headers: { authorization: "Bearer tok" },
  });
  await new Promise((r) => ws.once("open", r));
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));

  ws.send("not json");
  await waitFor(() => frames.length > 0);
  assert.ok((frames[0] as { error?: { code: string } }).error);

  // The daemon is still alive: a fresh rpc on the SAME connection round-trips.
  ws.send(
    JSON.stringify({ id: "fresh", instance: "runtime", session: "default", method: "agent.list" }),
  );
  await waitFor(() => frames.some((f) => f.id === "fresh"));
  const reply = frames.find((f) => f.id === "fresh") as { result: { agents: unknown[] } };
  assert.equal(reply.result.agents.length, 1);

  ws.close();
  await handle.close();
  await fake.close();
});

test("handle.close() does not hang on a lingering client WebSocket", async () => {
  const { fake, handle } = await boot();
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/parent/ws`, {
    headers: { authorization: "Bearer tok" },
  });
  await new Promise((r) => ws.once("open", r));
  // Deliberately left open — close() must forcibly reap it, not wait forever
  // for it to end on its own.
  await handle.close();
  await fake.close();
});
