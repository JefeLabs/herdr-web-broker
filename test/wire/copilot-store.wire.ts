import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** WT-5 — does copilot's `session-store.db` record enough to prove a turn
 * finished, or only that a session existed?
 *
 * Like codex, copilot has no launch-time pin (`--connect` addresses remote
 * sessions, it does not mint a local id), so discovery must run from the
 * pane's cwd back to a session row.
 *
 * Inspecting the store on one machine (2026-08-29) answered half of it and
 * raised the other half. `sessions(id, cwd, repository, host_type, branch,
 * summary, created_at, updated_at)` had 7 rows, so cwd discovery is clearly
 * possible. But `turns(id, session_id, turn_index, user_message,
 * assistant_response, timestamp)` was EMPTY, as were
 * `forge_trajectory_events` and `assistant_usage_events`, and the newest
 * session had `updated_at == created_at` with a null summary.
 *
 * Static inspection cannot tell those two apart:
 *   (a) copilot does not write turn rows at all in this version, or
 *   (b) those 7 sessions simply never completed a turn.
 *
 * Only a session the probe drives to completion itself distinguishes them,
 * which is exactly why this one has to spawn rather than read.
 *
 * If (a) — copilot stays on the status tier, and the store is useful only for
 * cwd -> session_id, not for turn state. That is the README's recorded
 * fallback, not a bug to fix. */

const BASE = process.env.HERDR_BASE ?? "http://127.0.0.1:7591";
const TOKEN = process.env.HERDR_TOKEN ?? "";
const S = `${BASE}/v1/instances/runtime/sessions/default`;
const DB_PATH = join(homedir(), ".copilot", "session-store.db");

async function call(path: string, method: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${S}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function rpc(method: string, params: unknown): Promise<unknown> {
  const res = (await call("/rpc", "POST", { method, params })) as { result?: unknown };
  return res?.result;
}

async function clearFirstRunGate(pane: string): Promise<void> {
  for (let i = 0; i < 16; i++) {
    const r = (await rpc("pane.read", { pane_id: pane, source: "visible" })) as { read?: { text?: string } };
    if (/trust|do you want to|allow|proceed\?/i.test(r.read?.text ?? "")) {
      await rpc("pane.send_input", { pane_id: pane, text: "", keys: ["Enter"] });
      await new Promise((res) => setTimeout(res, 4000));
      return;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
}

/** Read-only, and through the WAL — a live copilot session is mid-write, so
 * the probe must see uncommitted-to-main-db pages the way src/transcript.ts's
 * sqlite reader does. */
function query<T>(sql: string, ...params: string[]): T[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

test("WT-5: copilot's session-store records a completed turn, not just a session", { skip: !process.env.HERDR_WIRE }, async () => {
  assert.ok(existsSync(DB_PATH), `no store at ${DB_PATH} — run copilot once before probing`);

  const cwd = mkdtempSync(join(tmpdir(), "hwb-wt5-"));
  const spawned = (await call("/agents", "POST", { kind: "copilot", cwd })) as {
    workspace_id?: string;
    pane_id?: string;
  };
  const pane = spawned.pane_id;
  const workspaceId = spawned.workspace_id;
  if (!pane || !workspaceId) throw new Error("agents spawn returned no pane/workspace id");

  try {
    await clearFirstRunGate(pane);
    await call(`/agents/${encodeURIComponent(pane)}/prompt`, "POST", { text: "say hello" });

    // ── 1. cwd discovery: does a session row appear for THIS cwd? ────────
    const deadline = Date.now() + 90_000;
    let sessionId: string | undefined;
    while (Date.now() < deadline) {
      const rows = query<{ id: string }>("SELECT id FROM sessions WHERE cwd = ? ORDER BY created_at DESC LIMIT 1", cwd);
      if (rows.length > 0) {
        sessionId = rows[0].id;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(
      sessionId,
      "FAILING THIS IS THE FINDING: no sessions row recorded this cwd, so there is no path from a " +
        "pane back to a copilot session at all — copilot stays on the status tier and the store is " +
        "not even useful for discovery.",
    );

    // ── 2. THE question: does a finished turn leave a row? ───────────────
    let turns = 0;
    let touched = false;
    while (Date.now() < deadline) {
      turns = query<{ c: number }>("SELECT COUNT(*) AS c FROM turns WHERE session_id = ?", sessionId)[0]?.c ?? 0;
      const s = query<{ created_at: string; updated_at: string }>(
        "SELECT created_at, updated_at FROM sessions WHERE id = ?",
        sessionId,
      )[0];
      touched = !!s && s.updated_at !== s.created_at;
      if (turns > 0) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log(`WT-5 session_id: ${sessionId}`);
    console.log(`WT-5 turns rows: ${turns}`);
    console.log(`WT-5 sessions.updated_at moved: ${touched}`);

    assert.ok(
      turns > 0,
      "FAILING THIS ASSERTION IS THE FINDING, NOT A BUG: copilot created a sessions row for this " +
        "cwd but wrote NO turns row for a completed turn, so the store carries session metadata " +
        `only (sessions.updated_at moved: ${touched}). There is no transcript-provable completion ` +
        "to read, so copilot stays on the status tier and cli-profiles.ts keeps no `transcript` " +
        "entry for it. Record this in the wire-truth table; the useful half is that " +
        "sessions.cwd -> sessions.id discovery DOES work, should a later version start writing turns.",
    );

    const turn = query<{ timestamp: string; assistant_response: string | null }>(
      "SELECT timestamp, assistant_response FROM turns WHERE session_id = ? ORDER BY turn_index DESC LIMIT 1",
      sessionId,
    )[0];
    assert.equal(typeof turn?.timestamp, "string", "a turn row needs a timestamp to bound freshness");
    console.log(`WT-5 newest turn: ${turn.timestamp}, assistant_response present: ${turn.assistant_response !== null}`);
  } finally {
    await call(`/workspaces/${encodeURIComponent(workspaceId)}`, "DELETE").catch(() => undefined);
  }
});
