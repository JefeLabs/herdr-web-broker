import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
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

/** Prove the agent is at ITS OWN prompt before sending anything.
 *
 * The first version of this pattern-matched the screen for known gate wordings
 * and pressed Enter. That is unsafe by construction: into a MENU, a prompt is
 * a SELECTION. On 2026-08-29 the codex probe sent "say hello" into an update
 * menu, which selected the highlighted "1. Update now", and the workspace
 * close in the finally block then killed `npm install -g` midway — leaving the
 * CLI installed but without its platform binary. A blocklist of known gate
 * wordings can never be complete; that is the same lesson the git.raw denylist
 * taught in 80786f2, and it is worse here because the failure ACTS.
 *
 * So: no blind input, ever. herdr's own `interactive_ready` is the readiness
 * signal. If it never arrives, ABORT and print the pane so a human can see
 * what is blocking, instead of gambling on whatever happens to be highlighted.
 * A gate is then cleared once by hand and the probe re-run. */
/** copilot opens on a "Restore interrupted sessions" picker listing every
 * session it has seen, with `enter restore · esc start fresh` at the foot.
 *
 * Enter here RESTORES a previous session — which is what defeated this probe
 * on 2026-08-29 before the screen was understood. copilot then legitimately
 * ran in an EARLIER probe's folder, so the pane showed that folder (which read
 * as a stale buffer, and was not) and no turn was ever written for the cwd
 * under test. Esc starts fresh in the pane's own cwd, which is the only thing
 * that makes the cwd -> session mapping mean anything.
 *
 * This is the same hazard as the codex update menu, one screen earlier: a
 * default action that is wrong for a probe. */
async function startFreshSession(pane: string): Promise<boolean> {
  const r = (await rpc("pane.read", { pane_id: pane, source: "visible" })) as { read?: { text?: string } };
  const text = r.read?.text ?? "";
  if (!/restore interrupted sessions|esc start fresh/i.test(text)) return false;
  await rpc("pane.send_input", { pane_id: pane, text: "", keys: ["Escape"] });
  await new Promise((res) => setTimeout(res, 3000));
  return true;
}

/** Clear ONE precisely-recognised gate: the first-run directory-trust prompt.
 *
 * This is deliberately NOT the pattern-match-and-press-Enter that broke the
 * codex run. Two differences make it safe. It fires only when the screen
 * matches the trust wording AND offers a numbered affirmative, so an
 * unrecognised menu still aborts. And it sends THAT NUMBER explicitly rather
 * than Enter, so it cannot action whatever happens to be highlighted — the
 * exact failure that selected "Update now".
 *
 * It exists because probes spawn into a fresh mkdtemp by design, which is
 * always an untrusted directory: no amount of trusting folders by hand can
 * pre-clear a path that does not exist yet. */
async function clearTrustGate(pane: string): Promise<boolean> {
  const r = (await rpc("pane.read", { pane_id: pane, source: "visible" })) as { read?: { text?: string } };
  const text = r.read?.text ?? "";
  // Wording and chrome vary per CLI: codex says "contents of this directory",
  // copilot says "files in this folder" and draws its menu inside box-drawing
  // borders with a U+276F pointer. So match the QUESTION loosely and find the
  // option by scanning lines for a numbered "Yes" rather than anchoring on a
  // glyph. The FIRST such option is taken deliberately — copilot also offers
  // "2. Yes, and remember this folder for future sessions", and a probe must
  // not persist trust for a temp directory it is about to delete.
  if (!/do you trust the (contents|files)/i.test(text)) return false;
  const affirmative = text
    .split("\n")
    .map((line) => /(\d+)\.\s+Yes\b/.exec(line))
    .find((m): m is RegExpExecArray => m !== null);
  if (!affirmative) return false;
  await rpc("pane.send_input", { pane_id: pane, text: affirmative[1], keys: ["Enter"] });
  await new Promise((res) => setTimeout(res, 5000));
  return true;
}

async function awaitAgentReady(pane: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = (await rpc("agent.list", {})) as {
      agents?: Array<{ pane_id?: string; interactive_ready?: boolean }>;
    };
    if ((list.agents ?? []).find((a) => a.pane_id === pane)?.interactive_ready === true) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const screen = (await rpc("pane.read", { pane_id: pane, source: "visible" })) as { read?: { text?: string } };
  throw new Error(
    `agent never reported interactive_ready within ${timeoutMs}ms — refusing to send input into ` +
      `whatever is on screen, because into a menu a prompt is a selection. Clear it by hand once, ` +
      `then re-run.\nPane:\n${(screen.read?.text ?? "(empty)").slice(-800)}`,
  );
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

  // realpath: macOS mkdtemp returns /var/..., the CLI records /private/var/...
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hwb-wt5-")));
  const spawned = (await call("/agents", "POST", { kind: "copilot", cwd })) as {
    workspace_id?: string;
    pane_id?: string;
  };
  const pane = spawned.pane_id;
  const workspaceId = spawned.workspace_id;
  if (!pane || !workspaceId) throw new Error("agents spawn returned no pane/workspace id");

  try {
    // One recognised gate may stand between spawn and readiness; clearing it
    // is explicit and narrow, and readiness is then re-proved either way.
    await awaitAgentReady(pane, 20_000).catch(async (first: unknown) => {
      // Two gates stand between spawn and readiness, in this order: the
      // restore picker, then the directory-trust prompt. Each is handled
      // explicitly; anything else re-throws the ORIGINAL error, which carries
      // the pane dump that is the whole diagnostic value of refusing to act.
      const fresh = await startFreshSession(pane);
      const trusted = await clearTrustGate(pane);
      if (!fresh && !trusted) throw first;
      await awaitAgentReady(pane);
    });
    await call(`/agents/${encodeURIComponent(pane)}/prompt`, "POST", { text: "say hello" });

    // ── 1. cwd discovery: does a session row appear for THIS cwd? ────────
    const deadline = Date.now() + 180_000;
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
      "copilot wrote NO turns row within the window. It DOES write them (confirmed 2026-08-29), " +
        `and the row lands on SUBMISSION rather than completion, ~65s after the prompt here ` +
        `(sessions.updated_at moved: ${touched}). So this is more likely a window or an auth ` +
        "problem than a format finding — check the pane for `Authorization error, you may need " +
        "to run /login` before recording anything about the schema.",
    );

    const turn = query<{ timestamp: string; user_message: string | null; assistant_response: string | null }>(
      "SELECT timestamp, user_message, assistant_response FROM turns WHERE session_id = ? ORDER BY turn_index DESC LIMIT 1",
      sessionId,
    )[0];
    assert.equal(typeof turn?.timestamp, "string", "a turn row needs a timestamp to bound freshness");
    console.log(`WT-5 newest turn: ${turn.timestamp}`);
    console.log(`WT-5 user_message: ${JSON.stringify(turn.user_message)}`);
    console.log(`WT-5 assistant_response present: ${turn.assistant_response !== null}`);

    // THE remaining question for a profile. The row exists from submission, so
    // its mere presence proves a turn STARTED, not that it finished — the
    // completion signal has to be assistant_response going non-null. Confirming
    // that needs an AUTHENTICATED copilot: on 2026-08-29 every probe run hit
    // "Authorization error, you may need to run /login", so the column stayed
    // null for a reason unrelated to the schema.
    assert.notEqual(
      turn.assistant_response,
      null,
      "assistant_response is still null — if the pane shows an Authorization error, run " +
        "`copilot` once and /login, then re-run. Until this passes, the completion SIGNAL is " +
        "unconfirmed and copilot stays on the status tier even though its schema is now known.",
    );
  } finally {
    await call(`/workspaces/${encodeURIComponent(workspaceId)}`, "DELETE").catch(() => undefined);
  }
});
