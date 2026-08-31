import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** WT-12 — does the BROKER's mode D actually reattach a conversation?
 *
 * WT-11 answered the CLI question and stopped there: `claude --resume <id>
 * --fork-session`, driven by passing `args` straight through, carries prior
 * context. That says nothing about roadmap 31's implementation, which is
 * where all the moving parts are — archiving the id when the pane dies,
 * surfacing it, resolving it back to a kind and a directory, and assembling
 * an argv that keeps the pin. Each of those can be wrong on its own while
 * the CLI behaves perfectly.
 *
 * The specific thing that could pass unit tests and fail here: the archive
 * is written at agent-stop from the broker's own index, and the resume then
 * has to land in the SAME directory the conversation lived in, because the
 * CLI keys transcripts on the cwd. A unit test with a fake herdr proves the
 * argv; only a live run proves the conversation came back.
 *
 * Deliberately an API-level probe. It reads nothing off disk — no transcript
 * paths, no session files — because the question is whether the broker's own
 * surfaces compose, and `ask` gives a structured answer through the very
 * channel a client would use. That also makes it immune to the instrument
 * problem that cost WT-11 two runs: there is no screen to misread and no
 * config dir to resolve. */

const BASE = process.env.HERDR_BASE ?? "http://127.0.0.1:7591";
const TOKEN = process.env.HERDR_TOKEN ?? "";
const S = `${BASE}/v1/instances/runtime/sessions/default`;

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

/** Status code and code string without throwing — the negative controls are
 * asserting the REFUSAL, so the error is the measurement. */
async function callStatus(path: string, method: string, body?: unknown): Promise<{ status: number; code?: string }> {
  const r = await fetch(`${S}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { code?: string }).code;
  } catch {
    code = undefined;
  }
  return { status: r.status, code };
}

async function rpc(method: string, params: unknown): Promise<unknown> {
  const res = (await call("/rpc", "POST", { method, params })) as { result?: unknown };
  return res?.result;
}

/** Same discipline as claude-resume.wire.ts: never send input into an
 * unrecognised screen, and name what is actually there when readiness never
 * arrives — an exited CLI and a waiting dialog need opposite fixes. */
function readinessDiagnosis(text: string): string {
  const err = /^\s*Error:.*$/m.exec(text);
  if (err) return `the CLI EXITED — it printed: ${err[0].trim()}. An argv rejection, not a gate.`;
  if (/do you trust|quick safety check/i.test(text)) {
    return "a TRUST DIALOG is on screen — trustProject did not cover this cwd (prepare-workspace.ts).";
  }
  return "nothing recognised is on screen; the pane dump is the whole diagnostic.";
}

async function awaitAgentReady(pane: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = (await rpc("agent.list", {})) as {
      agents?: Array<{ pane_id?: string; interactive_ready?: boolean }>;
    };
    if ((list.agents ?? []).find((a) => a.pane_id === pane)?.interactive_ready === true) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const screen = (await rpc("pane.read", { pane_id: pane, source: "visible" })) as { read?: { text?: string } };
  const text = screen.read?.text ?? "(empty)";
  throw new Error(
    `agent in ${pane} never reported interactive_ready within ${timeoutMs}ms. ` +
      `Diagnosis: ${readinessDiagnosis(text)}\nPane:\n${text.slice(-900)}`,
  );
}

interface Resumable {
  sessionId: string;
  kind: string;
  cwd: string;
  endedAt: number;
}

test("WT-12 refusals: mode D rejects what it cannot honestly do", { skip: !process.env.HERDR_WIRE }, async () => {
  // No spawn — these are pure API rejections, so they run in milliseconds
  // and rule out a broken deployment before the expensive half. Same reason
  // WT-11 has a separate discovery test.
  const unknown = await callStatus("/agents", "POST", { resume: { session_id: "no-such-conversation" } });
  assert.equal(unknown.code, "unknown_session_ref", `expected unknown_session_ref, got ${JSON.stringify(unknown)}`);
  assert.equal(unknown.status, 404, "an id that names nothing is a missing resource");

  const both = await callStatus("/agents", "POST", { resume: { session_id: "a", pane_id: "w1:p1" } });
  assert.equal(both.code, "bad_request", "exactly one of session_id and pane_id");

  console.log("WT-12 refusals: unknown_session_ref 404 and the one-of rule both hold");
});

test("WT-12: stop an agent, find it in /resumable, and get the conversation back", { skip: !process.env.HERDR_WIRE }, async () => {
  // realpath: macOS mkdtemp returns /var/..., the CLI records /private/var/...
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hwb-wt12-")));
  const nonce = `wt12-${Math.random().toString(36).slice(2, 10)}`;
  const workspaces: string[] = [];

  try {
    // ── 1. a conversation worth resuming ─────────────────────────────────
    const first = (await call("/agents", "POST", { kind: "claude", cwd })) as {
      workspace_id?: string;
      pane_id?: string;
    };
    if (!first.pane_id || !first.workspace_id) throw new Error("spawn returned no pane/workspace id");
    workspaces.push(first.workspace_id);
    await awaitAgentReady(first.pane_id);

    // ask rather than prompt: it BLOCKS until the agent writes its answer
    // file, so the turn is provably complete before the pane is closed.
    // WT-11 had to poll a transcript for this.
    const seeded = (await call(`/agents/${encodeURIComponent(first.pane_id)}/ask`, "POST", {
      prompt: `Remember this exact token for later: ${nonce}. Answer with the string "ok".`,
      timeout_ms: 180_000,
    })) as { answer?: unknown };
    console.log(`WT-12 seed answer: ${JSON.stringify(seeded.answer)}`);

    // ── 2. the agent dies — which is when its id used to disappear ────────
    await call(`/agents/${encodeURIComponent(first.pane_id)}`, "DELETE");

    // ── 3. THE archive question (roadmap 31a and 31b together) ────────────
    const listing = (await call("/resumable", "GET")) as { resumable?: Resumable[] };
    const rows = listing.resumable ?? [];
    console.log(`WT-12 resumable rows: ${rows.length}`);
    const row = rows.find((r) => r.cwd === cwd);
    assert.ok(
      row,
      "FAILING HERE IS THE FINDING: the conversation was not archived when its pane closed, so the id " +
        `died with the pane exactly as it did before roadmap 31. Rows seen: ${JSON.stringify(rows.slice(0, 5))}`,
    );
    assert.equal(row.kind, "claude");
    console.log(`WT-12 archived id: ${row.sessionId} (kind ${row.kind}, cwd ${row.cwd})`);

    // ── 4. resume by id, naming NO directory ─────────────────────────────
    // The cwd default is load-bearing: the CLI keys transcripts on the
    // directory, so landing anywhere else reattaches nothing.
    const second = (await call("/agents", "POST", { resume: { session_id: row.sessionId } })) as {
      workspace_id?: string;
      pane_id?: string;
    };
    if (!second.pane_id || !second.workspace_id) throw new Error("resume spawn returned no pane/workspace id");
    workspaces.push(second.workspace_id);
    const spaces = (await call("/workspaces", "GET")) as { workspaces?: Array<{ workspace_id: string; cwd: string }> };
    const landed = (spaces.workspaces ?? []).find((w) => w.workspace_id === second.workspace_id)?.cwd;
    assert.equal(landed, cwd, "the resumed agent landed in the conversation's own directory, unasked");
    await awaitAgentReady(second.pane_id);

    // ── 5. does it REMEMBER? ─────────────────────────────────────────────
    const recalled = (await call(`/agents/${encodeURIComponent(second.pane_id)}/ask`, "POST", {
      prompt:
        "What exact token were you asked to remember earlier in this conversation? " +
        'Answer with just that token as a string, or the string "NONE" if you were never given one.',
      timeout_ms: 180_000,
    })) as { answer?: unknown };
    const answer = JSON.stringify(recalled.answer ?? null);
    console.log(`WT-12 recall answer: ${answer}`);

    assert.ok(
      answer.includes(nonce),
      `THE FINDING: the resumed agent did not produce ${nonce}, so the broker's mode D did not reattach ` +
        `the conversation (it answered ${answer}). WT-11 proved the CLI can do this, so a failure here is ` +
        "roadmap 31's own machinery — check the archived cwd, the argv the pane was launched with, and " +
        "that the pin and --resume both survived into agent.start.",
    );

    // ── 6. the mismatch refusal, on live infrastructure ──────────────────
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "hwb-wt12-other-")));
    const mismatch = await callStatus("/agents", "POST", {
      resume: { session_id: row.sessionId },
      cwd: elsewhere,
    });
    assert.equal(mismatch.code, "bad_request", "resuming into the wrong directory must be refused, not faked");
    console.log("WT-12 cwd-mismatch refusal holds against a live archive");
  } finally {
    for (const w of workspaces) {
      try {
        await call(`/workspaces/${encodeURIComponent(w)}`, "DELETE");
      } catch (e) {
        // Reports rather than swallows — see claude-resume.wire.ts's note on
        // the cleanup catch that hid roadmap 32 for four runs.
        console.log(`WT-12 cleanup: workspace ${w} NOT closed — ${String(e).split("\n")[0]}`);
      }
    }
  }
});
