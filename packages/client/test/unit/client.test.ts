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
      "http://b/instances/my%20box/sessions/default/agents?fresh=1",
      "http://b/instances/my%20box/sessions/default/workspaces",
      "http://b/instances/runtime/models?kind=claude",
    ]);
  });

  test("signOut() self-evicts via DELETE /auth with the presented bearer", async () => {
    const { calls, fetchFn } = fake(200, '{"signed_out":"me","token_revoked":true,"sockets_closed":1}');
    const out = await new BrokerClient({ origin: "http://b", token: "mine", fetchFn }).signOut();
    expect(out.signed_out).toBe("me");
    expect(out.token_revoked).toBe(true);
    expect(calls[0].url).toBe("http://b/auth");
    expect(calls[0].init.method).toBe("DELETE");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer mine");
  });

  test("worktree spawn opts + worktrees()/removeWorktree() hit the documented paths", async () => {
    const { calls, fetchFn } = fake(
      200,
      '{"workspace_id":"w6","pane_id":"w6:p1","agent":"copilot","status":"idle","worktree":{"branch":"feat-x","path":"/wt/feat-x"}}',
    );
    const session = new BrokerClient({ origin: "", token: "t", fetchFn }).instance("runtime").session("default");
    const agent = await session.spawn({ kind: "copilot", cwd: "/repo", worktree: { branch: "feat-x", base: "main" } });
    expect(agent.spawned?.worktree).toEqual({ branch: "feat-x", path: "/wt/feat-x" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      kind: "copilot",
      cwd: "/repo",
      worktree: { branch: "feat-x", base: "main" },
    });

    await session.worktrees("w1");
    expect(calls[1].url).toBe("/instances/runtime/sessions/default/workspaces/w1/worktrees");
    await session.removeWorktree("w6", { force: true });
    expect(calls[2].url).toBe("/instances/runtime/sessions/default/worktrees/w6?force=1");
    expect(calls[2].init.method).toBe("DELETE");
  });

  test("closeWorkspace() reaps via DELETE on the workspace", async () => {
    const { calls, fetchFn } = fake(200, '{"workspace_id":"w2","closed":true}');
    const session = new BrokerClient({ origin: "", token: "t", fetchFn }).instance("runtime").session("default");
    const out = await session.closeWorkspace("w2");
    expect(out.closed).toBe(true);
    expect(calls[0].url).toBe("/instances/runtime/sessions/default/workspaces/w2");
    expect(calls[0].init.method).toBe("DELETE");
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
    expect(calls[0].url).toBe("/instances/runtime/sessions/default/workspaces/w1/repos/-/tree");
    expect(calls[1].url).toBe("/instances/runtime/sessions/default/workspaces/w1/repos/-/file?path=notes.md");
  });

  test("git verbs: commit/log/push/checkout hit their routes with the right shapes", async () => {
    const { calls, fetchFn } = fake(200, '{"committed":true,"commit":"abc","branch":"main"}');
    const repo = new BrokerClient({ origin: "", token: "t", fetchFn }).instance("runtime").session("default").repo("w1", ".");
    await repo.commit({ message: "vibe: keep it" });
    await repo.log(5);
    await repo.push();
    await repo.checkout("feat/x", { create: true });
    expect(calls.map((c) => c.url)).toEqual([
      "/instances/runtime/sessions/default/workspaces/w1/repos/-/git/commit",
      "/instances/runtime/sessions/default/workspaces/w1/repos/-/git/log?limit=5",
      "/instances/runtime/sessions/default/workspaces/w1/repos/-/git/push",
      "/instances/runtime/sessions/default/workspaces/w1/repos/-/git/checkout",
    ]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ message: "vibe: keep it" });
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ ref: "feat/x", create: true });
  });

  test("context scope: raw upload body, list, binary download, toggle, delete", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/context")) {
        return new Response(
          '{"attachments":[{"name":"spec.pdf","size":4,"content_type":"application/pdf","active":true,"uploaded_at":"now"}]}',
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if ((init?.method ?? "GET") === "GET") {
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "application/pdf" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const ctx = new BrokerClient({ origin: "", token: "t", fetchFn }).instance("runtime").session("default").context("w1");

    const up = await ctx.upload("spec.pdf", new Uint8Array([1, 2, 3, 4]), { contentType: "application/pdf" });
    expect(up.name).toBe("spec.pdf");
    expect(calls[0].url).toBe("/instances/runtime/sessions/default/workspaces/w1/context/spec.pdf");
    expect(calls[0].init.method).toBe("PUT");
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe("application/pdf");

    const dl = await ctx.download("spec.pdf");
    expect([...dl.content]).toEqual([1, 2, 3, 4]);
    expect(dl.contentType).toBe("application/pdf");

    await ctx.setActive("spec.pdf", false);
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ active: false });
    await ctx.delete("spec.pdf");
    expect(calls.at(-1)!.init.method).toBe("DELETE");
  });

  test("setToken applies to subsequent calls", async () => {
    const { calls, fetchFn } = fake(200, "{}");
    const broker = new BrokerClient({ origin: "", token: "old", fetchFn });
    broker.setToken("new");
    await broker.instances();
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer new");
  });
});
