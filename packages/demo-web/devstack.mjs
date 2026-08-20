#!/usr/bin/env node
// Local demo stack: the REAL broker daemon (from ../../dist) attached to a
// scripted herdr simulator, plus a seeded multi-repo workspace — so every
// endpoint on the demo site works end-to-end without herdr or Docker.
//
//   npm run build          (repo root — compiles dist/)
//   node packages/demo-web/devstack.mjs
//   npm run dev            (in packages/demo-web — the site proxies to :7591)
//
// The simulator speaks herdr 0.8.0's verified wire shapes (one-shot rpc,
// subscribe-only event channels) because it extends the same FakeHerdr the
// test suite uses. Agents "answer" ask() prompts by writing the JSON file
// the broker's file-drop handshake expects.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../dist/src/daemon.js";
import { FakeHerdr } from "../../dist/test/fake-herdr.js";

const TOKEN = process.env.BROKER_TOKEN ?? "demo-token";
const LISTEN = process.env.BROKER_LISTEN ?? "127.0.0.1:7591";

// ── seeded workspace: one working set, n repos ─────────────────────────────
const root = mkdtempSync(join(tmpdir(), "herdr-demo-"));
const work = join(root, "work");

function seedRepo(dir, files, { dirty = false } = {}) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=demo@example.com", "-c", "user.name=demo", "commit", "-qm", "seed");
  if (dirty) {
    writeFileSync(join(dir, Object.keys(files)[0]), `${Object.values(files)[0]}\n// local work in progress\n`);
    writeFileSync(join(dir, "NOTES.md"), "untracked scratch file\n");
  }
}

seedRepo(
  join(work, "app"),
  {
    "package.json": '{ "name": "app", "version": "1.0.0" }\n',
    "src/index.ts": 'import { greet } from "./util";\nconsole.log(greet("herdr"));\n',
    "src/util.ts": 'export const greet = (s: string) => `hello ${s}`;\n',
    "README.md": "# app\nThe team's main service.\n",
  },
  { dirty: true },
);
seedRepo(join(work, "lib", "core"), {
  "core.ts": "export const VERSION = 1;\n",
  "README.md": "# core\nShared library, nested one level down.\n",
});

// ── herdr simulator ────────────────────────────────────────────────────────
const fake = new FakeHerdr(join(root, "herdr.sock"));
const workspaces = new Map([["w1", { cwd: work, label: "demo team" }]]);
let nextWs = 2;
fake.agents = [
  { pane_id: "w1:p1", workspace_id: "w1", agent: "copilot", name: "copilot", agent_status: "working", interactive_ready: true, launch_pending: false },
  { pane_id: "w1:p2", workspace_id: "w1", agent: "claude", name: "claude", agent_status: "blocked", interactive_ready: true, launch_pending: false },
];

fake.handlers.set("workspace.list", () => ({
  type: "workspace_list",
  workspaces: [...workspaces].map(([workspace_id, w]) => ({ workspace_id, ...w })),
}));

fake.handlers.set("workspace.create", (p) => {
  const id = `w${nextWs++}`;
  workspaces.set(id, { cwd: p?.cwd ?? work, ...(p?.label ? { label: p.label } : {}) });
  return { type: "workspace_created", workspace_id: id, root_pane: { pane_id: `${id}:p1` } };
});

fake.handlers.set("agent.start", (p) => {
  fake.agents.push({
    pane_id: p.pane_id,
    workspace_id: String(p.pane_id).split(":")[0],
    agent: p.kind,
    name: p.name ?? p.kind,
    agent_status: "idle",
    interactive_ready: true,
    launch_pending: false,
  });
  return { type: "agent_started" };
});

fake.handlers.set("pane.send_input", (p) => {
  const rm = /rm -f (\S+)/.exec(String(p?.text ?? ""));
  if (rm) rmSync(rm[1], { force: true }); // honor the env drop-file cleanup
  return { type: "ok" };
});
fake.handlers.set("pane.send_text", () => ({ type: "ok" }));
fake.handlers.set("pane.send_keys", () => ({ type: "ok" }));
fake.handlers.set("pane.read", () => ({
  type: "pane_read",
  // ticks every ~3s so the live pane viewer's long-poll has changes to show
  read: { text: `user@sim:~/work % _\n[sim] heartbeat ${Math.floor(Date.now() / 3000)}` },
}));

const setStatus = (name, status) => {
  const a = fake.agents.find((x) => x.name === name || x.agent === name);
  if (!a) return;
  a.agent_status = status;
  fake.emitEvent("pane.agent_status_changed", {
    agent: a.agent,
    agent_status: status,
    pane_id: a.pane_id,
    workspace_id: a.workspace_id,
  });
};

fake.handlers.set("agent.prompt", (p) => {
  const text = String(p?.text ?? "");
  const target = String(p?.target ?? "agent");

  // spec-bundle drafting: the sim "agent" writes design files over a few
  // seconds so the long-poll GET has live updates to return
  const spec = /spec bundle at (docs\/superpowers\/specs\/[0-9a-z-]+)\/ \(relative to (.+?)\)/.exec(text);
  if (spec) {
    const dir = join(spec[2], spec[1]);
    setStatus(target, "working");
    const plan = /implementation plan to .*plan\.md/.test(text);
    setTimeout(() => {
      if (plan) {
        writeFileSync(
          join(dir, "plan.md"),
          "# plan\n\n1. Build the API layer (api.md) — tests first.\n2. Wire the data model.\n3. Demo + docs.\n",
        );
      } else {
        writeFileSync(
          join(dir, "overview.md"),
          "# overview\n\nThe simulated agent is drafting this bundle.\n\n## Goals\n- prove the long-poll\n\n## Open questions\n- Which auth flow do you prefer?\n",
        );
      }
    }, 900);
    if (!plan) {
      setTimeout(() => {
        writeFileSync(join(dir, "api.md"), "# api\n\n`GET /things` — list things.\n`POST /things` — make one.\n");
        setStatus(target, "idle");
      }, 2200);
    } else {
      setTimeout(() => setStatus(target, "idle"), 1200);
    }
    return { type: "prompted" };
  }

  const m = /\.herdr\/answers\/([a-f0-9]{16})\.json \(relative to (.+?)\)\./.exec(text);
  setStatus(target, "working");
  if (m) {
    const file = join(m[2], ".herdr", "answers", `${m[1]}.json`);
    setTimeout(() => {
      mkdirSync(join(m[2], ".herdr", "answers"), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          from: `sim-${target}`,
          prompt_seen: String(p.text).slice(0, 96),
          repos: ["app", "lib/core"],
        }),
      );
      setStatus(target, "idle");
    }, 900);
  } else {
    setTimeout(() => setStatus(target, "idle"), 900);
  }
  return { type: "prompt_sent" };
});

await fake.listen();

// ── the real broker ────────────────────────────────────────────────────────
// e2e runs need a KNOWN admin token: pre-seed the state-dir file the daemon
// would otherwise mint randomly (ensureAdminToken reads it if present).
if (process.env.BROKER_ADMIN_TOKEN) {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "admin-token"), process.env.BROKER_ADMIN_TOKEN, { mode: 0o600 });
}
const handle = await startDaemon({
  configDir: join(root, "config"),
  stateDir: join(root, "state"),
  projectionDir: join(root, "remotes"),
  herdrVersion: "0.8.0-sim",
  localEndpoints: [{ session: "default", socketPath: fake.socketPath }],
  configOverrides: {
    listen: LISTEN,
    token_mint: { enabled: true },
    client_tokens: [{ name: "demo", token: TOKEN }],
  },
});
if (!handle) {
  console.error("another broker already holds the lock — stop it first");
  process.exit(1);
}

console.log(`[devstack] broker      ${handle.base}`);
console.log(`[devstack] bearer      ${TOKEN}`);
console.log(`[devstack] admin token ${handle.adminToken}`);
console.log(`[devstack] workspace   ${work} (repos: app [dirty], lib/core)`);
console.log(`[devstack] ctrl-c to stop`);

async function shutdown() {
  await handle.close().catch(() => undefined);
  await fake.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
