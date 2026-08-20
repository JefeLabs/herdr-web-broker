import { describe, expect, test } from "vitest";
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
