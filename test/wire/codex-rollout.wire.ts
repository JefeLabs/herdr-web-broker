import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** WT-4 — what does a codex `rollout-*.jsonl` look like, and can the broker
 * find the right one for a pane?
 *
 * codex has NO launch-time pin: `codex resume [SESSION_ID]` resumes, it does
 * not mint, so the broker cannot tell codex which id to use the way it does
 * for claude (`--session-id`) and opencode (`--session`). Discovery therefore
 * has to go the other way — from the pane's cwd back to a rollout file — and
 * that is only possible if the rollout records its own cwd.
 *
 * Two things must both hold for codex to leave the status tier:
 *   1. a rollout written for a FRESH cwd is findable by that cwd, and
 *   2. a finished turn carries a terminal marker with a usable timestamp.
 *
 * Inspection of existing rollouts on one machine (2026-08-29) says both do:
 * every line is `{ timestamp, type, payload }`; a `session_meta` line carries
 * `payload.cwd` and `payload.session_id`; and a completed turn ends with an
 * `event_msg` whose `payload.type` is `task_complete` (alongside
 * `task_started` and `user_message`). This probe is what turns that reading
 * of old files into a fact about a session the broker itself just spawned —
 * the distinction that matters, because a stale file proves nothing about
 * what the CURRENT codex writes.
 *
 * If it fails, codex stays on the status tier (README's wire-truth table). */

const BASE = process.env.HERDR_BASE ?? "http://127.0.0.1:7591";
const TOKEN = process.env.HERDR_TOKEN ?? "";
const S = `${BASE}/v1/instances/runtime/sessions/default`;
const SESSIONS_DIR = join(homedir(), ".codex", "sessions");

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
 * a SELECTION. On 2026-08-29 this probe sent "say hello" into codex's update
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

interface Rollout {
  path: string;
  rows: Array<{ timestamp?: string; type?: string; payload?: Record<string, unknown> }>;
}

/** rollouts are filed under sessions/YYYY/MM/DD/, so the search is recursive
 * rather than a flat glob — and it matches on the RECORDED cwd, which is the
 * discovery path the broker would have to use. */
function findRolloutForCwd(cwd: string): Rollout | undefined {
  if (!existsSync(SESSIONS_DIR)) return undefined;
  const files = readdirSync(SESSIONS_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".jsonl") && f.includes("rollout-"))
    .map((f) => join(SESSIONS_DIR, f));
  for (const path of files) {
    let rows: Rollout["rows"];
    try {
      rows = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Rollout["rows"][number]);
    } catch {
      continue; // a rollout being written right now is not the one we want
    }
    const meta = rows.find((r) => r.type === "session_meta");
    // Direct compare, both sides already resolved: the caller passes a cwd it
    // ran realpathSync on at spawn, and the CLI records the resolved path.
    // (macOS mkdtemp hands back /var/folders/..., a symlink to
    // /private/var/folders/... — comparing unresolved would miss every match.)
    // Resolving the RECORDED value here instead would throw ENOENT on every
    // historical rollout whose directory has since been deleted.
    if (meta?.payload?.cwd === cwd) return { path, rows };
  }
  return undefined;
}

test("WT-4: a codex rollout is findable by cwd and marks a completed turn", { skip: !process.env.HERDR_WIRE }, async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hwb-wt4-")));
  const spawned = (await call("/agents", "POST", { kind: "codex", cwd })) as {
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
      // Re-throw the ORIGINAL error on failure: it carries the pane dump, which
      // is the entire diagnostic value of refusing to act.
      if (!(await clearTrustGate(pane))) throw first;
      await awaitAgentReady(pane);
    });
    // An unprompted agent may never write a turn at all — the store only
    // proves anything once something has been asked of it.
    await call(`/agents/${encodeURIComponent(pane)}/prompt`, "POST", { text: "say hello" });

    // ── 1. cwd discovery ────────────────────────────────────────────────
    const deadline = Date.now() + 60_000;
    let found: Rollout | undefined;
    while (Date.now() < deadline) {
      found = findRolloutForCwd(cwd);
      if (found) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(
      found,
      "FAILING THIS IS THE FINDING: no rollout recorded this cwd within 60s, so there is no " +
        "path from a pane back to its transcript — codex has no launch pin either, so it stays " +
        "on the status tier. Check whether session_meta still carries `cwd` in this codex version.",
    );

    const meta = found.rows.find((r) => r.type === "session_meta");
    assert.equal(typeof meta?.payload?.session_id, "string", "session_meta must carry a session_id");

    // ── 2. terminal marker ──────────────────────────────────────────────
    let complete: Rollout["rows"][number] | undefined;
    while (Date.now() < deadline) {
      const fresh = findRolloutForCwd(cwd);
      complete = fresh?.rows.find(
        (r) => r.type === "event_msg" && (r.payload as { type?: string } | undefined)?.type === "task_complete",
      );
      if (complete) {
        found = fresh;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(
      complete,
      "FAILING THIS IS THE FINDING: the turn produced no `task_complete` event_msg, so there is " +
        "no transcript-provable completion for codex and it stays on the status tier. Record the " +
        "types that DID appear (logged below) — the terminal vocabulary may simply have been renamed.",
    );
    assert.equal(typeof complete.timestamp, "string", "the terminal record needs a timestamp to bound freshness");

    // The answer, in the form a cli-profiles.ts entry needs.
    const kinds = new Set(
      found!.rows.map((r) => `${r.type}/${(r.payload as { type?: string } | undefined)?.type ?? "-"}`),
    );
    console.log(`WT-4 rollout: ${found!.path}`);
    console.log(`WT-4 record kinds: ${[...kinds].join(", ")}`);
    console.log(`WT-4 terminal: event_msg/task_complete at ${complete.timestamp}`);
  } finally {
    await call(`/workspaces/${encodeURIComponent(workspaceId)}`, "DELETE").catch(() => undefined);
  }
});
