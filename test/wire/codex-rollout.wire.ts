import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
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

/** Every agent CLI probed so far gates a directory it has not seen before
 * (agy's "Do you trust the contents of this project?" defeated WT-2 entirely
 * until it was handled). Probes spawn into a fresh mkdtemp by design, so they
 * hit that gate every run. Accept whatever the default selection is. */
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
    if (meta?.payload?.cwd === cwd) return { path, rows };
  }
  return undefined;
}

test("WT-4: a codex rollout is findable by cwd and marks a completed turn", { skip: !process.env.HERDR_WIRE }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hwb-wt4-"));
  const spawned = (await call("/agents", "POST", { kind: "codex", cwd })) as {
    workspace_id?: string;
    pane_id?: string;
  };
  const pane = spawned.pane_id;
  const workspaceId = spawned.workspace_id;
  if (!pane || !workspaceId) throw new Error("agents spawn returned no pane/workspace id");

  try {
    await clearFirstRunGate(pane);
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
