#!/usr/bin/env node
// Drift probe: exercises the broker's verified-herdr surface against the
// demo container (REAL latest herdr + Copilot CLI, installed at image
// build). Every assertion here is a wire behavior the broker depends on —
// if upstream herdr changes one, this run turns red before a user does.
//
//   docker run -d --rm --name herdr-web-demo -p 7591:7591 herdr-web-demo
//   node scripts/drift-probe.mjs
//
// Plain HTTP, no browser: the e2e suite owns the UI; this owns the wire.

const BASE = process.env.BROKER_URL ?? "http://127.0.0.1:7591";
const TOKEN = process.env.BROKER_TOKEN ?? "demo-token";
const SESSION = `${BASE}/parent/runtime/sessions/default`;

let failures = 0;

function check(label, ok, detail) {
  const mark = ok ? "ok " : "DRIFT";
  console.log(`[${mark}] ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. health
{
  const r = await call("GET", "/health");
  check("health answers ok + name", r.status === 200 && r.body?.ok === true && r.body?.name === "herdr-web-broker", JSON.stringify(r));
}

// 2. spawn — exercises workspace.create + agent.start + the pane-busy retry
let pane;
{
  const r = await call("POST", "/parent/runtime/sessions/default/agents", {
    kind: "copilot",
    cwd: "/work",
    label: "drift probe",
  });
  const b = r.body ?? {};
  check(
    "spawn: 201 with {workspace_id, pane_id, agent: string, status}",
    r.status === 201 && typeof b.workspace_id === "string" && typeof b.pane_id === "string" &&
      typeof b.agent === "string" && ["working", "blocked", "idle"].includes(b.status),
    JSON.stringify(r),
  );
  pane = b.pane_id;
}

// 3. agent.list shape via fresh=1 — id/title/status + raw_status
{
  const r = await call("GET", "/parent/runtime/sessions/default/agents?fresh=1");
  const agents = r.body?.agents ?? [];
  const mine = agents.find((a) => a.id === pane);
  check(
    "agents?fresh=1 lists the spawned pane with folded status + raw_status",
    r.status === 200 && mine !== undefined && ["working", "blocked", "idle"].includes(mine.status) &&
      typeof mine.raw_status === "string",
    JSON.stringify({ status: r.status, mine, count: agents.length }),
  );
}

// 4. screen — pane.read must yield the CLI's actual TUI within 60s
let version;
{
  let text = "";
  let ok = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = await call("GET", `/parent/runtime/sessions/default/panes/${encodeURIComponent(pane)}/screen`);
    text = r.body?.text ?? "";
    version = r.body?.version;
    if (r.status === 200 && /copilot|trust|login/i.test(text)) {
      ok = true;
      break;
    }
    await sleep(2_000);
  }
  check("screen shows the Copilot TUI (pane.read works)", ok, `last screen: ${text.slice(0, 200)}`);
  check("screen carries a version hash", typeof version === "string" && /^[a-f0-9]{16}$/.test(version ?? ""), String(version));
}

// 5. answer the trust dialog through pane.send_input, then long-poll for
//    the changed frame — the pair proves write + change-detection
{
  const sent = await call("POST", "/parent/runtime/sessions/default/rpc", {
    method: "pane.send_input",
    params: { pane_id: pane, text: "1", keys: ["Enter"] },
  });
  check("pane.send_input accepted", sent.status === 200, JSON.stringify(sent));

  let changed = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = await call(
      "GET",
      `/parent/runtime/sessions/default/panes/${encodeURIComponent(pane)}/screen?version=${version}&wait_ms=10000`,
    );
    if (r.status === 200 && r.body?.unchanged !== true && r.body?.version !== version) {
      changed = true;
      break;
    }
  }
  check("screen long-poll delivers a changed frame after input", changed, "no new version within 60s");
}

// 6. status fold still reaches the registry (the WS event path's source)
{
  const r = await call("GET", "/parent/runtime");
  check(
    "instance detail: online with a sessions rollup",
    r.status === 200 && r.body?.online === true && Array.isArray(r.body?.sessions),
    JSON.stringify(r.body ?? {}).slice(0, 200),
  );
}

console.log(failures === 0 ? "\nno drift detected" : `\n${failures} drift check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
