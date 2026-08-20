/* In-process devstack: the REAL broker daemon wired to a scripted herdr
 * simulator (the same FakeHerdr the root suite uses), listening on an
 * ephemeral port. Requires the repo root to be built (`npm run build`). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TOKEN = "integration-token";

export interface Stack {
  base: string;
  work: string;
  emitStatus(pane: string, status: string): void;
  stop(): Promise<void>;
}

export async function bootStack(): Promise<Stack> {
  const { startDaemon } = (await import("../../../../dist/src/daemon.js")) as {
    startDaemon: (opts: Record<string, unknown>) => Promise<{
      base: string;
      close(): Promise<void>;
    }>;
  };
  const { FakeHerdr } = (await import("../../../../dist/test/fake-herdr.js")) as {
    FakeHerdr: new (path: string) => {
      agents: Record<string, unknown>[];
      handlers: Map<string, (params: unknown) => unknown>;
      listen(): Promise<void>;
      close(): Promise<void>;
      emitEvent(event: string, data: object): void;
    };
  };

  const root = mkdtempSync(join(tmpdir(), "sdk-integration-"));
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });

  const fake = new FakeHerdr(join(root, "herdr.sock"));
  const workspaces = new Map<string, { cwd: string }>();
  let nextWs = 1;

  fake.handlers.set("workspace.list", () => ({
    type: "workspace_list",
    workspaces: [...workspaces].map(([workspace_id, w]) => ({ workspace_id, ...w })),
  }));
  fake.handlers.set("workspace.create", (p) => {
    const id = `w${nextWs++}`;
    workspaces.set(id, { cwd: (p as { cwd?: string })?.cwd ?? work });
    return { type: "workspace_created", workspace_id: id, root_pane: { pane_id: `${id}:p1` } };
  });
  fake.handlers.set("agent.start", (p) => {
    const q = p as { pane_id: string; kind: string; name?: string };
    fake.agents.push({
      pane_id: q.pane_id,
      workspace_id: q.pane_id.split(":")[0],
      agent: q.kind,
      name: q.name ?? q.kind,
      agent_status: "idle",
      interactive_ready: true,
    });
    return { type: "agent_started" };
  });
  fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
  fake.handlers.set("pane.send_keys", () => ({ type: "ok" }));
  fake.handlers.set("pane.read", () => ({ type: "pane_read", read: { text: "user@sim % _" } }));
  fake.handlers.set("agent.prompt", (p) => {
    const text = String((p as { text?: string })?.text ?? "");
    const ask = /\.herdr\/answers\/([a-f0-9]{16})\.json \(relative to (.+?)\)\./.exec(text);
    if (ask) {
      const file = join(ask[2], ".herdr", "answers", `${ask[1]}.json`);
      setTimeout(() => {
        mkdirSync(join(ask[2], ".herdr", "answers"), { recursive: true });
        writeFileSync(file, '{"answer":{"ok":true,"from":"sim"}}');
      }, 150);
      return { type: "prompted" };
    }
    const spec = /spec bundle at (docs\/superpowers\/specs\/[0-9a-z-]+)\/ \(relative to (.+?)\)/.exec(text);
    if (spec) {
      const dir = join(spec[2], spec[1]);
      setTimeout(() => writeFileSync(join(dir, "overview.md"), "# overview\n\ndrafted by the sim\n"), 300);
    }
    return { type: "prompted" };
  });
  await fake.listen();

  const handle = await startDaemon({
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    projectionDir: join(root, "remotes"),
    herdrVersion: "0.8.0-sim",
    localEndpoints: [{ session: "default", socketPath: join(root, "herdr.sock") }],
    wsPingMs: 200,
    configOverrides: {
      listen: "127.0.0.1:0",
      client_tokens: [{ name: "t", token: TOKEN }],
    },
  });
  if (!handle) throw new Error("daemon refused to start (another lock?)");

  return {
    base: handle.base,
    work,
    emitStatus: (pane, status) =>
      fake.emitEvent("pane.agent_status_changed", {
        agent: "copilot",
        agent_status: status,
        pane_id: pane,
        workspace_id: pane.split(":")[0],
      }),
    stop: async () => {
      await handle.close();
      await fake.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
