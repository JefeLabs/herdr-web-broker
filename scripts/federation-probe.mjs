#!/usr/bin/env node
// Federation probe: drives an enrolled CHILD entirely through the PARENT's
// HTTP API — the end-to-end validation of every "routes through
// callInstance" claim. Run by scripts/federation-test.sh against two real
// containers; assumes the child is (or was) paired as $FED_CHILD.
//
//   node scripts/federation-probe.mjs                 # main checks
//   node scripts/federation-probe.mjs --phase=offline # after child stops

const BASE = process.env.BROKER_URL ?? "http://127.0.0.1:7691";
const TOKEN = process.env.BROKER_TOKEN ?? "demo-token";
const CHILD = process.env.FED_CHILD ?? "laptop";
const PHASE = process.argv.includes("--phase=offline") ? "offline" : "main";

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`[${ok ? "ok " : "FAIL"}] ${label}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function childEntry() {
  const r = await call("GET", "/instances");
  return (r.body?.instances ?? []).find((i) => i.instance === CHILD);
}

if (PHASE === "offline") {
  let entry;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    entry = await childEntry();
    if (entry && entry.online === false) break;
    await sleep(2_000);
  }
  check("stopped child flips to offline on the parent", entry?.online === false, JSON.stringify(entry));
  console.log(failures === 0 ? "\nfederation offline phase: green" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

// 1. enrollment — the child appears online (it boots herdr + dials out, so poll)
{
  let entry;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    entry = await childEntry();
    if (entry?.online) break;
    await sleep(2_000);
  }
  check(`child '${CHILD}' enrolled and online`, entry?.online === true, JSON.stringify(entry ?? "absent"));
}

// 2. instance detail + sessions over the tunnel
{
  const r = await call("GET", `/instances/${CHILD}`);
  check(
    "instance detail: online with sessions incl. 'default'",
    r.status === 200 && r.body?.online === true && (r.body?.sessions ?? []).includes("default"),
    JSON.stringify(r.body ?? {}).slice(0, 200),
  );
}

// 3. herdr passthrough: agent list on the child
{
  const r = await call("GET", `/instances/${CHILD}/sessions/default/agents`);
  check("agents passthrough answers", r.status === 200 && Array.isArray(r.body?.agents), JSON.stringify(r));
}

// 3b. event passthrough: subscribe to the CHILD's lifecycle events over the
//     parent's WS — check 4's spawn must then arrive as a pushed herdr_event
//     that crossed child herdr → tunnel → parent → client socket
let wsEvents;
{
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/events?token=${TOKEN}`);
  const frames = [];
  ws.addEventListener("message", (ev) => {
    try {
      frames.push(JSON.parse(String(ev.data)));
    } catch {
      /* a malformed frame only matters if the checks below miss theirs */
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("events socket refused")));
  });
  ws.send(
    JSON.stringify({
      id: "sub1",
      instance: CHILD,
      session: "default",
      method: "broker.events.subscribe",
      params: { subscriptions: [{ type: "workspace.created" }, { type: "pane.created" }] },
    }),
  );
  let ack;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(ack = frames.find((f) => f.id === "sub1"))) await sleep(200);
  check(
    "broker.events.subscribe on the child acks with a sub_id",
    typeof ack?.result?.sub_id === "string",
    JSON.stringify(ack ?? "no ack in 15s"),
  );
  wsEvents = { ws, frames };
}

// 4. broker.* over the tunnel: spawn a real agent ON the child
let pane, workspace;
{
  const r = await call("POST", `/instances/${CHILD}/sessions/default/agents`, {
    kind: "copilot",
    cwd: "/work",
    label: "federation probe",
  });
  const b = r.body ?? {};
  check(
    "spawn on the child through the parent: 201 + shape",
    r.status === 201 && typeof b.pane_id === "string" && typeof b.workspace_id === "string",
    JSON.stringify(r),
  );
  pane = b.pane_id;
  workspace = b.workspace_id;
}

// 4b. the spawn's lifecycle event streamed back as push, not poll
{
  let evt;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    evt = wsEvents.frames.find(
      (f) =>
        f.event?.type === "herdr_event" &&
        f.event.instance === CHILD &&
        /^(workspace_created|pane_created)$/.test(f.event.name),
    );
    if (evt) break;
    await sleep(1_000);
  }
  check(
    "child lifecycle event pushed through the tunnel to the parent's WS",
    Boolean(evt),
    `no herdr_event in 30s; saw ${JSON.stringify(wsEvents.frames.slice(-3)).slice(0, 300)}`,
  );
  wsEvents.ws.close();
}

// 5. the child's real TUI, screen-read through the parent
let version;
{
  let text = "";
  let ok = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = await call("GET", `/instances/${CHILD}/sessions/default/panes/${encodeURIComponent(pane)}/screen`);
    text = r.body?.text ?? "";
    version = r.body?.version;
    if (r.status === 200 && /copilot|trust|login/i.test(text)) {
      ok = true;
      break;
    }
    await sleep(2_000);
  }
  check("child pane screen shows the Copilot TUI via the parent", ok, `last: ${text.slice(0, 160)}`);
}

// 6. write into the child pane + long-poll the change — rpc + screen both tunnel
{
  const sent = await call("POST", `/instances/${CHILD}/sessions/default/rpc`, {
    method: "pane.send_input",
    params: { pane_id: pane, text: "1", keys: ["Enter"] },
  });
  check("pane.send_input over the tunnel accepted", sent.status === 200, JSON.stringify(sent));
  let changed = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = await call(
      "GET",
      `/instances/${CHILD}/sessions/default/panes/${encodeURIComponent(pane)}/screen?version=${version}&wait_ms=10000`,
    );
    if (r.status === 200 && r.body?.unchanged !== true && r.body?.version !== version) {
      changed = true;
      break;
    }
  }
  check("screen long-poll delivers the changed frame", changed, "no new version within 60s");
}

// 7. env registry on the child through the parent
{
  const set = await call("POST", `/instances/${CHILD}/env`, { name: "FED_PROBE_VAR", value: "x", kind: "copilot" });
  const list = await call("GET", `/instances/${CHILD}/env`);
  check(
    "env set+list on the child (values never returned)",
    set.status === 200 && list.status === 200 &&
      (list.body?.vars ?? []).some((v) => v.name === "FED_PROBE_VAR") &&
      !JSON.stringify(list.body).includes('"x"'),
    JSON.stringify(list.body ?? {}).slice(0, 200),
  );
}

// 8. the remote deny-list holds: server.stop must never cross the tunnel
{
  const r = await call("POST", `/instances/${CHILD}/sessions/default/rpc`, { method: "server.stop", params: {} });
  check(
    "server.stop refused by the remote deny-list",
    r.status >= 400 && typeof r.body?.code === "string",
    JSON.stringify(r),
  );
}

// 9. mode-B spawn through the tunnel: a second agent joins the SAME
//    workspace on the child (pane.split federated; default-name collision
//    auto-uniques)
let paneB;
{
  const r = await call("POST", `/instances/${CHILD}/sessions/default/agents`, {
    kind: "copilot",
    workspace_id: workspace,
  });
  const b = r.body ?? {};
  check(
    "mode-B spawn joins the same child workspace via the parent",
    r.status === 201 && b.workspace_id === workspace && typeof b.pane_id === "string" && b.pane_id !== pane,
    JSON.stringify(r),
  );
  paneB = b.pane_id;
}

// 10. lifecycle cleanup through the parent: stop ONE agent (the workspace
//     survives — paneB remains), then close the whole workspace. Wire
//     truth from the first run of this probe: herdr reaps a workspace when
//     its LAST pane closes, so single-pane stops self-clean.
{
  const stop = await call("DELETE", `/instances/${CHILD}/sessions/default/agents/${encodeURIComponent(pane)}`);
  check("agent stop on the child via the parent", stop.status === 200 && stop.body?.stopped === true, JSON.stringify(stop));
  const close = await call("DELETE", `/instances/${CHILD}/sessions/default/workspaces/${encodeURIComponent(workspace)}`);
  check(
    "workspace close on the child via the parent (paneB still lived there)",
    close.status === 200 && close.body?.closed === true,
    JSON.stringify(close) + ` paneB=${paneB}`,
  );
}

console.log(failures === 0 ? "\nfederation main phase: green" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
