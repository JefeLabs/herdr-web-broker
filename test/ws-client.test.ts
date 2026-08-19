import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import WebSocket from "ws";
import { startDaemon } from "../src/daemon.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir, waitFor } from "./util.js";

async function boot() {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  fake.agents = [{ id: "a1", title: "claude", status: "working" }];
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

  fake.emitEvent({
    type: "pane.agent_status_changed",
    agent: { id: "a1", title: "claude", status: "blocked" },
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
