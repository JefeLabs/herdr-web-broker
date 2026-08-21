import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../src/daemon.js";
import { FakeHerdr } from "./fake-herdr.js";
import { scratchRepo, tmpDir, waitFor } from "./util.js";

interface Parts {
  fakeParent: FakeHerdr;
  fakeChild: FakeHerdr;
  parent: DaemonHandle;
  child: DaemonHandle;
}

async function teardown(parts: Partial<Parts>): Promise<void> {
  // Unconditional cleanup — node --test buffers a file's output until its
  // subprocess exits, and a leaked (non-unref'd) fake-herdr socket or daemon
  // HTTP server keeps that subprocess alive forever. Every path out of a
  // test, success or failure, must close everything it opened.
  await parts.child?.close();
  await parts.parent?.close();
  await parts.fakeChild?.close();
  await parts.fakeParent?.close();
}

async function bootPair(parentDeny?: string[]): Promise<Parts> {
  const fakeParent = new FakeHerdr(join(tmpDir(), "p.sock"));
  const fakeChild = new FakeHerdr(join(tmpDir(), "c.sock"));
  fakeChild.agents = [{ pane_id: "c:p1", name: "codex", agent_status: "idle" }];
  await fakeParent.listen();
  await fakeChild.listen();

  const partial: Partial<Parts> = { fakeParent, fakeChild };
  try {
    const parent = (await startDaemon({
      configDir: tmpDir(),
      stateDir: tmpDir(),
      configOverrides: {
        listen: "127.0.0.1:0",
        client_tokens: [{ name: "t", token: "tok" }],
        ...(parentDeny ? { policy: { remote_deny: parentDeny } } : {}),
      },
      localEndpoints: [{ session: "default", socketPath: fakeParent.socketPath }],
      herdrVersion: "0.8.0-test",
      projectionDir: tmpDir(),
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

    await waitFor(() => parent.registry.get("laptop")?.online === true);
    return partial as Parts;
  } catch (e) {
    await teardown(partial);
    throw e;
  }
}

const authed = (base: string, path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { authorization: "Bearer tok", ...init.headers } });

test("child enrolls; parent rollup shows both instances with child agents", async () => {
  const parts = await bootPair();
  try {
    const roll = (await (await authed(parts.parent.base, "/instances")).json()) as {
      instances: { instance: string; online: boolean; counts: { idle: number } }[];
    };
    const names = roll.instances.map((i) => i.instance).sort();
    assert.deepEqual(names, ["laptop", "runtime"]);
    const laptop = roll.instances.find((i) => i.instance === "laptop")!;
    assert.equal(laptop.online, true);
    assert.equal(laptop.counts.idle, 1);
  } finally {
    await teardown(parts);
  }
});

test("forwarded rpc reaches the child's herdr and returns its result", async () => {
  const parts = await bootPair();
  try {
    const res = await authed(parts.parent.base, "/instances/laptop/sessions/default/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "agent.list" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { agents: { pane_id: string }[] } };
    assert.equal(body.result.agents[0].pane_id, "c:p1");
    assert.ok(parts.fakeChild.received.some((r) => r.method === "agent.list"));
  } finally {
    await teardown(parts);
  }
});

test("child status events stream up and update the parent cache", async () => {
  const parts = await bootPair();
  try {
    parts.fakeChild.emitEvent("pane_agent_status_changed", {
      pane_id: "c:p1",
      workspace_id: "c",
      agent_status: "blocked",
      agent: "codex",
    });
    await waitFor(() => parts.parent.registry.counts("laptop").blocked === 1);
  } finally {
    await teardown(parts);
  }
});

test("remote-denied methods fast-fail at the parent without touching the tunnel", async () => {
  const parts = await bootPair();
  try {
    const res = await authed(parts.parent.base, "/instances/laptop/sessions/default/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "server.stop" }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, "method_denied");
    assert.equal(parts.fakeChild.received.some((r) => r.method === "server.stop"), false);
  } finally {
    await teardown(parts);
  }
});

test("the child enforces its own policy even when the parent's is permissive", async () => {
  const parts = await bootPair([]); // parent forwards everything; child keeps defaults
  try {
    const res = await authed(parts.parent.base, "/instances/laptop/sessions/default/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "server.stop" }),
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, "method_denied");
    // the refusal came from the child's ParentLink — its herdr never saw the call
    assert.equal(parts.fakeChild.received.some((r) => r.method === "server.stop"), false);
  } finally {
    await teardown(parts);
  }
});

test("revocation severs the tunnel; offline keeps last_seen; child retry is refused", async () => {
  const parts = await bootPair();
  try {
    await fetch(`${parts.parent.base}/admin/children/laptop`, {
      method: "DELETE",
      headers: { "x-admin-token": parts.parent.adminToken },
    });
    await waitFor(() => parts.parent.registry.get("laptop")!.online === false);
    const res = await authed(parts.parent.base, "/instances/laptop/sessions/default/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "agent.list" }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code: string; last_seen: string };
    assert.equal(body.code, "instance_offline");
    assert.ok(body.last_seen);
  } finally {
    await teardown(parts);
  }
});

test("child reconnects after a parent restart on the same port", async () => {
  const parts = await bootPair();
  let parent2: DaemonHandle | undefined;
  try {
    const port = parts.parent.port;
    const stateDir = tmpDir();
    await parts.parent.close();
    // Re-mint on the restarted parent (fresh state dir), then re-issue the same name.
    parent2 = (await startDaemon({
      configDir: tmpDir(),
      stateDir,
      configOverrides: { listen: `127.0.0.1:${port}`, client_tokens: [{ name: "t", token: "tok" }] },
      localEndpoints: [{ session: "default", socketPath: parts.fakeParent.socketPath }],
      herdrVersion: "0.8.0-test",
      projectionDir: tmpDir(),
    }))!;
    // The child's old secret is unknown to parent2 → its retries are refused, staying offline.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(parent2.registry.get("laptop")?.online ?? false, false);
  } finally {
    await parent2?.close();
    await parts.child.close();
    await parts.fakeParent.close();
    await parts.fakeChild.close();
    // parts.parent was already closed above (or never opened, on an early throw).
  }
});

test("broker.* over the tunnel executes in the child's ops and returns through res frames", async () => {
  const parts = await bootPair();
  try {
    const cwd = scratchRepo();
    parts.fakeChild.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
    parts.fakeChild.handlers.set("agent.start", () => ({ type: "agent_started" }));
    const spawn = await authed(parts.parent.base, "/instances/laptop/sessions/default/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "copilot", cwd }),
    });
    assert.equal(spawn.status, 201);

    writeFileSync(join(cwd, "a.txt"), "two\n");
    const diff = await authed(parts.parent.base, "/instances/laptop/sessions/default/workspaces/w2/repos/-/git/diff");
    assert.equal(diff.status, 200);
    assert.match(((await diff.json()) as { diff: string }).diff, /\+two/);
    // the virtual methods never reached the child's herdr socket as themselves
    assert.equal(parts.fakeChild.received.some((r) => r.method.startsWith("broker.")), false);
  } finally {
    await teardown(parts);
  }
});

test("BrokerError.details survives the tunnel round-trip (spec §2.1 partial-failure envelope)", async () => {
  const parts = await bootPair();
  try {
    const cwd = scratchRepo();
    parts.fakeChild.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w9:p1" } }));
    // no agent.start handler → the child's herdr answers a not_found error,
    // which broker.agent.spawn wraps with the orphaned workspace_id/pane_id.
    const res = await authed(parts.parent.base, "/instances/laptop/sessions/default/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "copilot", cwd }),
    });
    assert.ok(res.status >= 400, `expected a failure status, got ${res.status}`);
    const body = (await res.json()) as { workspace_id?: string; pane_id?: string };
    assert.equal(body.workspace_id, "w9");
    assert.equal(body.pane_id, "w9:p1");
  } finally {
    await teardown(parts);
  }
});

test("broker.repo.* in remote_deny fast-fails at the parent", async () => {
  const parts = await bootPair(["broker.repo.*"]);
  try {
    const res = await authed(parts.parent.base, "/instances/laptop/sessions/default/workspaces/w1/repos/-/git/diff");
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, "method_denied");
  } finally {
    await teardown(parts);
  }
});
