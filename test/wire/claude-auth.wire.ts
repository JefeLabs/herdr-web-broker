import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** WT-13 — what does a BROKER-SPAWNED claude actually show, and can the
 * broker tell?
 *
 * Found 2026-08-31 while WT-12 could not reach its own question: `prepare`
 * redirects CLAUDE_CONFIG_DIR to a broker-owned dir so a trust dialog is
 * answered inside the broker's blast radius, and that redirect relocates the
 * CLI's WHOLE config tree — credentials with it. Every broker-spawned claude
 * is logged out, and every signal the broker has says otherwise:
 * `agent.list` reports it detected and `interactive_ready`, `agent.prompt`
 * succeeds, the transcript grows, and the evidence tier reads a completed
 * turn — correctly, because a turn DID complete. In ~0s, into `<synthetic>`.
 *
 * This probe answers the half a probe CAN answer: what is on the screen, and
 * is it distinguishable? It does NOT answer what the intended auth path is —
 * that needs a decision (API key via `POST .../env` vs. `prepare` inheriting
 * credentials) and a key this probe deliberately does not carry.
 *
 * Instrument notes, all of them earned by earlier probes on this table:
 *  - `pane.read` answers { type, read: { text } }. The text is NESTED; WT-1
 *    read `.text`, got "", and blamed a transport bug that did not exist.
 *  - It never sends input. A claude that IS logged in sits at a prompt; a
 *    logged-out one sits behind a banner. Typing into an unidentified screen
 *    is how WT-5 burned four rounds — in a menu, a prompt is a SELECTION.
 *  - Cleanup logs and never throws: a cleanup that throws masks the result
 *    it runs after, and a cleanup that swallows made a real leak look tidy
 *    (roadmap 32).
 *  - An empty read is an instrument reading zero, not a logged-in agent, and
 *    is asserted against explicitly.
 */

const BASE = process.env.HERDR_BASE ?? "http://127.0.0.1:7591";
const TOKEN = process.env.HERDR_TOKEN ?? "";
const S = `${BASE}/v1/instances/runtime/sessions/default`;
const auth = { authorization: `Bearer ${TOKEN}` };

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${S}${path}`, {
    method,
    headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ANSWERED 2026-08-31, and the assertion is now INVERTED to pin it, per this
 * directory's convention: it passes as a regression guard and goes red only if
 * the behavior changes.
 *
 * The answer: a broker-spawned claude is NOT authenticated, its pane reads
 * `Not logged in · Run /login` — note "Run", not "Please run" as the roadmap
 * prose had it — and the broker now REFUSES the spawn instead of handing back
 * a green pane. The workspace survives the refusal on purpose, so a caller can
 * supply a credential and retry mode B into it.
 *
 * Both worlds are handled. On a machine whose claude IS authenticated the
 * refusal must NOT happen, and this still passes — asserting instead that no
 * banner is on the screen. What can never pass is the shipped bug: a spawn
 * that succeeds while the pane says it cannot work. */
test("WT-13: a broker-spawned claude that cannot authenticate is refused, not handed back", { skip: !process.env.HERDR_WIRE }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "wt13-"));
  const spawned = await api("POST", "/agents", { kind: "claude", cwd, label: "wt13-auth" });
  console.log(`spawn -> ${spawned.status} ${JSON.stringify(spawned.body)}`);

  if (spawned.status === 502 && spawned.body?.code === "agent_unauthenticated") {
    console.log("\nREFUSED, as designed. message:\n  " + spawned.body.message);
    const ws = spawned.body.workspace_id;
    assert.ok(ws, "the refusal must carry workspace_id — without it the caller cannot retry mode B");
    assert.ok(spawned.body.pane_id, "and pane_id");
    // The contract that makes the refusal recoverable rather than a dead end.
    const list = await api("GET", "/workspaces");
    const kept = (list.body?.workspaces ?? []).some((w: any) => w.workspace_id === ws);
    assert.ok(kept, `workspace ${ws} must survive the refusal so a credentialed retry can use it`);
    console.log(`workspace ${ws} survived the refusal — mode-B retry is possible`);
    const del = await api("DELETE", `/workspaces/${ws}`);
    if (del.status !== 200) console.log(`cleanup: DELETE workspace -> ${del.status} ${JSON.stringify(del.body)}`);
    return;
  }

  // The other world: this machine's claude is authenticated. Then the spawn
  // must succeed AND the pane must be clean — a success with the banner up is
  // the bug this item exists for.
  assert.ok(
    spawned.status === 200 || spawned.status === 201,
    `unexpected spawn outcome: ${spawned.status} ${JSON.stringify(spawned.body)}`,
  );
  const { pane_id: pane, workspace_id: ws } = spawned.body;
  try {
    await sleep(4000);
    const screen = await api("GET", `/panes/${pane}/screen`);
    // read.text is NESTED on the raw rpc; this REST route already flattens it.
    const text: string = screen.body?.text ?? "";
    console.log("=== PANE, VERBATIM ===\n" + text + "\n=== END PANE ===");
    assert.notEqual(text.trim(), "", "empty read is the instrument at zero, not an answer");
    assert.ok(
      !text.includes("Not logged in"),
      "spawn SUCCEEDED while the pane says the agent is not logged in — this is roadmap 33's bug",
    );
    console.log("this claude is authenticated; no banner, spawn correctly allowed");
  } finally {
    const del = await api("DELETE", `/workspaces/${ws}`);
    if (del.status !== 200) console.log(`cleanup: DELETE workspace -> ${del.status} ${JSON.stringify(del.body)}`);
  }
});
