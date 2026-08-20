import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BrokerClient } from "../../src/client.js";
import type { Bundle } from "../../src/types.js";
import { bootStack, TOKEN, type Stack } from "./stack.js";

const run = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

run("SDK against the in-process broker stack", () => {
  let stack: Stack;
  let broker: BrokerClient;

  beforeAll(async () => {
    stack = await bootStack();
    broker = new BrokerClient({ origin: stack.base, token: "wrong" });
  }, 30_000);

  afterAll(async () => {
    broker?.events.close();
    await stack?.stop();
  });

  test("the whole conversation lifecycle over the real wire", async () => {
    // auth: wrong token reports, right token verifies
    expect((await broker.verify()).ok).toBe(false);
    broker.setToken(TOKEN);
    expect((await broker.verify()).ok).toBe(true);

    const session = broker.instance("runtime").session("default");

    // spawn → prompt → ask
    const agent = await session.spawn({ kind: "copilot", cwd: stack.work });
    expect(agent.paneId).toMatch(/^w\d+:p1$/);
    expect((await agent.prompt("hello there")).status).toBe("prompted");
    const asked = await agent.ask("give me a payload", { timeoutMs: 10_000 });
    expect(asked.answer).toEqual({ ok: true, from: "sim" });

    // CLI controls
    expect((await agent.slash("clear")).command).toBe("/clear");
    expect((await agent.setModel("gpt-5")).command).toBe("/model gpt-5");
    expect(await agent.read()).toContain("user@sim");

    // spec bundle drive + follow sees the sim's draft land
    const receipt = await agent.spec("integration", "draft the design");
    const versions: Bundle[] = [];
    const stop = session.bundles(agent.paneId.split(":")[0]).follow(receipt.bundle, (b) => versions.push(b), {
      waitMs: 3_000,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("follow never saw the draft")), 8_000);
        const timer = setInterval(() => {
          if (versions.some((b) => b.files["overview.md"]?.content.includes("drafted by the sim"))) {
            clearTimeout(deadline);
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    } finally {
      stop();
    }

    // events: WS connects with subprotocol auth; status frames arrive
    const statuses: unknown[] = [];
    broker.events.on("agent_status", (e) => statuses.push(e));
    await new Promise<void>((resolve) => {
      const off = broker.events.on("open", () => {
        off();
        resolve();
      });
      broker.events.connect();
    });
    await session.agents({ fresh: true }); // triggers per-pane resubscription
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("no agent_status event within 8s")), 8_000);
      const timer = setInterval(() => {
        stack.emitStatus(agent.paneId, "working");
        if (statuses.length > 0) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
    expect((statuses[0] as { agent: { id: string } }).agent.id).toBe(agent.paneId);

    // rpc over the same socket
    const list = (await broker.events.rpc("runtime", "default", "agent.list")) as { type: string };
    expect(list.type).toBe("agent_list");
  }, 40_000);
});
