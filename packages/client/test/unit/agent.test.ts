import { describe, expect, test, vi } from "vitest";
import { BrokerApiError } from "../../src/errors.js";
import { BrokerClient } from "../../src/client.js";

function fake(replies: { status: number; body: string }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const agentOf = (fetchFn: typeof fetch) =>
  new BrokerClient({ origin: "", token: "t", fetchFn }).instance("runtime").session("default").agent("w1:p1");

describe("AgentHandle", () => {
  test("prompt / slash / setModel hit their routes with the right bodies", async () => {
    const { calls, fetchFn } = fake([{ status: 200, body: '{"status":"prompted"}' }]);
    const agent = agentOf(fetchFn);
    await agent.prompt("focus on tests");
    await agent.slash("instructions", "keep it short");
    await agent.slash("clear");
    await agent.setModel("gpt-5");
    expect(calls.map((c) => [c.url, String(c.init.body)])).toEqual([
      ["/parent/runtime/sessions/default/agents/w1%3Ap1/prompt", '{"text":"focus on tests"}'],
      ["/parent/runtime/sessions/default/agents/w1%3Ap1/slash/instructions", '{"args":"keep it short"}'],
      ["/parent/runtime/sessions/default/agents/w1%3Ap1/slash/clear", "{}"],
      ["/parent/runtime/sessions/default/agents/w1%3Ap1/model", '{"model":"gpt-5"}'],
    ]);
  });

  test("ask sends the clamped timeout and surfaces agent_unresponsive as a typed error", async () => {
    const ok = fake([{ status: 200, body: '{"answer":{"x":1}}' }]);
    const out = await agentOf(ok.fetchFn).ask("give me x", { timeoutMs: 5000 });
    expect(out.answer).toEqual({ x: 1 });
    expect(JSON.parse(String(ok.calls[0].init.body))).toEqual({ prompt: "give me x", timeout_ms: 5000 });

    const dead = fake([{ status: 504, body: '{"code":"agent_unresponsive","message":"dead","pane_id":"w1:p1"}' }]);
    const err = (await agentOf(dead.fetchFn).ask("hello").catch((e) => e)) as BrokerApiError;
    expect(err.code).toBe("agent_unresponsive");
    expect(err.details.pane_id).toBe("w1:p1");
  });

  test("interrupt and read ride the rpc passthrough", async () => {
    const { calls, fetchFn } = fake([
      { status: 200, body: '{"result":{"type":"ok"}}' },
      { status: 200, body: '{"result":{"read":{"text":"❯ _"}}}' },
    ]);
    const agent = agentOf(fetchFn);
    await agent.interrupt();
    const text = await agent.read();
    expect(text).toBe("❯ _");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      method: "pane.send_keys",
      params: { pane_id: "w1:p1", keys: ["Escape"] },
    });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      method: "pane.read",
      params: { pane_id: "w1:p1", source: "visible" },
    });
  });

  test("screen hits the panes route with query params and returns the frame", async () => {
    const frame = '{"pane_id":"w1:p1","source":"visible","text":"❯ _","version":"abcd","as_of":"now"}';
    const { calls, fetchFn } = fake([{ status: 200, body: frame }]);
    const agent = agentOf(fetchFn);
    const s = await agent.screen();
    expect(s).toMatchObject({ text: "❯ _", version: "abcd" });
    expect(calls[0].url).toBe("/parent/runtime/sessions/default/panes/w1%3Ap1/screen");

    await agent.screen({ source: "recent", version: "abcd", waitMs: 25_000 });
    expect(calls[1].url).toContain("/panes/w1%3Ap1/screen?");
    expect(calls[1].url).toContain("source=recent");
    expect(calls[1].url).toContain("version=abcd");
    expect(calls[1].url).toContain("wait_ms=25000");
  });

  test("watchScreen threads versions, skips unchanged, delivers changes, and stops on unsubscribe", async () => {
    const frameJson = (version: string) =>
      JSON.stringify({ pane_id: "w1:p1", source: "visible", text: `screen ${version}`, version, as_of: "now" });
    const replies: ({ status: number; body: string } | "pend")[] = [
      { status: 200, body: frameJson("v1") },
      { status: 200, body: '{"pane_id":"w1:p1","source":"visible","version":"v1","unchanged":true}' },
      { status: 200, body: frameJson("v2") },
      "pend",
    ];
    const urls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      const r = replies[Math.min(urls.length, replies.length - 1)];
      urls.push(String(url));
      if (r === "pend") return new Promise<Response>(() => undefined);
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const seen: string[] = [];
    const stop = agentOf(fetchFn).watchScreen((s) => seen.push(s.version), { waitMs: 25_000 });
    await vi.waitFor(() => expect(seen).toEqual(["v1", "v2"]));
    expect(urls[0]).not.toContain("version=");
    expect(urls[1]).toContain("version=v1");
    expect(urls[1]).toContain("wait_ms=25000");
    stop();
    expect(urls.length).toBe(4);
  });

  test("type and keys ride the rpc passthrough", async () => {
    const { calls, fetchFn } = fake([{ status: 200, body: '{"result":{"type":"ok"}}' }]);
    const agent = agentOf(fetchFn);
    await agent.type("1");
    await agent.keys(["Down", "Enter"]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      method: "pane.send_input",
      params: { pane_id: "w1:p1", text: "1", keys: ["Enter"] },
    });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      method: "pane.send_keys",
      params: { pane_id: "w1:p1", keys: ["Down", "Enter"] },
    });
  });

  test("spec uses {name} for new bundles and {bundle} for dated ids; plan targets plan.md", async () => {
    const { calls, fetchFn } = fake([{ status: 201, body: '{"status":"prompted"}' }]);
    const agent = agentOf(fetchFn);
    await agent.spec("checkout flow", "draft it", { file: "api.md" });
    await agent.spec("2026-08-20-checkout-flow", "answer: OAuth");
    await agent.plan("2026-08-20-checkout-flow", "backend first");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: "checkout flow", prompt: "draft it", file: "api.md" });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ bundle: "2026-08-20-checkout-flow", prompt: "answer: OAuth" });
    expect(calls[2].url).toBe(
      "/parent/runtime/sessions/default/agents/w1%3Ap1/spec-bundles/2026-08-20-checkout-flow/plan",
    );
  });
});
