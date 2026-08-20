import { describe, expect, test } from "vitest";
import { BrokerClient } from "../../src/client.js";

function fake(status: number, body: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("BrokerClient", () => {
  test("reads hit the documented paths with encoded segments", async () => {
    const { calls, fetchFn } = fake(200, '{"agents":[]}');
    const broker = new BrokerClient({ origin: "http://b", token: "t", fetchFn });
    const session = broker.instance("my box").session("default");
    await session.agents({ fresh: true });
    await session.workspaces();
    await broker.instance("runtime").models("claude");
    expect(calls.map((c) => c.url)).toEqual([
      "http://b/parent/my%20box/sessions/default/agents?fresh=1",
      "http://b/parent/my%20box/sessions/default/workspaces",
      "http://b/parent/runtime/models?kind=claude",
    ]);
  });

  test("verify() reports auth failure without throwing", async () => {
    const { fetchFn } = fake(401, '{"code":"unauthorized","message":"nope"}');
    const out = await new BrokerClient({ origin: "", token: "bad", fetchFn }).verify();
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("unauthorized");
  });

  test("spawn posts the body and returns a pane-bound AgentHandle", async () => {
    const { calls, fetchFn } = fake(201, '{"workspace_id":"w1","pane_id":"w1:p1","agent":"copilot","status":"idle"}');
    const session = new BrokerClient({ origin: "", token: "t", fetchFn }).instance("runtime").session("default");
    const agent = await session.spawn({ kind: "copilot", cwd: "/work" });
    expect(agent.paneId).toBe("w1:p1");
    expect(agent.spawned?.workspace_id).toBe("w1");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ kind: "copilot", cwd: "/work" });
  });

  test("rpc wraps method+params and unwraps nothing", async () => {
    const { calls, fetchFn } = fake(200, '{"result":{"type":"pong"}}');
    const session = new BrokerClient({ origin: "", token: "t", fetchFn }).instance("runtime").session("default");
    const out = (await session.rpc("ping", {})) as { result: { type: string } };
    expect(out.result.type).toBe("pong");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ method: "ping", params: {} });
  });

  test("repo '.' (the discovered root-repo path) maps to the '-' token — browsers collapse /./ segments", async () => {
    const { calls, fetchFn } = fake(200, "{}");
    const session = new BrokerClient({ origin: "", token: "t", fetchFn }).instance("runtime").session("default");
    await session.repo("w1", ".").tree();
    await session.repo("w1", ".").file("notes.md");
    expect(calls[0].url).toBe("/parent/runtime/sessions/default/workspaces/w1/repos/-/tree");
    expect(calls[1].url).toBe("/parent/runtime/sessions/default/workspaces/w1/repos/-/file?path=notes.md");
  });

  test("setToken applies to subsequent calls", async () => {
    const { calls, fetchFn } = fake(200, "{}");
    const broker = new BrokerClient({ origin: "", token: "old", fetchFn });
    broker.setToken("new");
    await broker.instances();
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer new");
  });
});
