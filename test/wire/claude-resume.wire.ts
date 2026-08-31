import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliProfiles } from "../../src/cli-profiles.js";
import { claudeCwdSlug } from "../../src/transcript.js";
import { configDirFor } from "../../src/prepare-workspace.js";

/** WT-11 — does `claude --resume <id>` REATTACH a prior conversation from a
 * cold start, and what does the resumed process do to the transcript record?
 *
 * Roadmap 31: the broker mints a session id, stores it as AgentMeta.sessionId,
 * reads it for exactly one purpose (locating a transcript), returns it from no
 * endpoint, and deletes the row when the pane closes. So today an agent that
 * dies mid-conversation is diagnosable — the evidence tier can PROVE it
 * finished a turn and never answered — and unrecoverable. Mode D (reattach
 * rather than start fresh) is what would make that detection actionable, and
 * it cannot be designed until this probe answers three separate things:
 *
 *   1. Does the flag REATTACH prior context, or merely start clean without
 *      erroring? WT-2 is the standing warning: agy ACCEPTS
 *      `--conversation <uuid>`, carries it into the terminal title, and mints
 *      nothing. Accepting a flag is not honoring it, and the difference is
 *      invisible unless the probe asks the model something only the earlier
 *      conversation could answer.
 *   2. Does the resumed process APPEND to the same transcript record, or open
 *      a new one? transcript.ts's `via: "path"` resolution keys off a single
 *      sessionId, so a resume that forks the record leaves AgentMeta pointing
 *      at a file that has stopped growing — the reader would then report a
 *      live agent as stalled, which is worse than not resuming at all.
 *   3. Does the resume flag COLLIDE with the pin flag? workspace-ops.ts:648
 *      appends `--session-id <fresh-uuid>` unconditionally for any kind whose
 *      profile has a `pin`, so a caller-supplied `--resume <id>` ships
 *      alongside it and the CLI is told to be two conversations at once.
 *      This probe cannot avoid the collision — it is what mode D must resolve.
 *
 * claude first because it is the only kind with a verified pin AND a
 * `prepare` block (so no first-run trust gate), and its `via: "path"`
 * transcript makes "same record vs new record" a directly observable fact
 * about the filesystem rather than an inference. The other three kinds need
 * their own probes; the candidate syntax for each is recorded below. */

const BASE = process.env.HERDR_BASE ?? "http://127.0.0.1:7591";
const TOKEN = process.env.HERDR_TOKEN ?? "";
const S = `${BASE}/v1/instances/runtime/sessions/default`;

/** Same resolution chain as cli.ts, because claude's transcript does NOT
 * live under ~/.claude when the broker spawned it: the profile's `prepare`
 * block redirects CLAUDE_CONFIG_DIR to a broker-owned dir under stateDir,
 * and that redirect moves the CLI's whole config tree, projects/ included.
 * A probe reading ~/.claude here finds nothing and reports a false negative —
 * the exact instrument failure the README's WT-1/WT-2 note describes. */
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), ".local/state/herdr-web-broker");

/** CANDIDATE resume syntax per kind — the shapes to try, none verified here.
 * This is the table that becomes `CliProfile.resume` (roadmap 31(e)) once
 * answered, the same way WT-3's answer became the `opencode` profile. It
 * lives in the probe until then, because an unverified profile field reads
 * like live config and is exactly the dead-config trap roadmap 25(e) closed.
 *
 * Note the shapes are NOT uniform — a flag, an `=`-joined flag, a different
 * flag name, and a SUBCOMMAND. That is why 31(e) stores the flag rather than
 * assuming one, and why the review's `sessionRef {kind, value}` warning
 * applies: a resume command cannot be reconstructed from a bare id. */
const RESUME_SYNTAX: Record<string, (id: string) => string[]> = {
  claude: (id) => ["--resume", id],
  copilot: (id) => [`--resume=${id}`],
  opencode: (id) => ["--session", id],
  codex: (id) => ["resume", id],
};

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

/** Prove the agent is at ITS OWN prompt before sending anything — never
 * pattern-match a screen and press Enter, because into a menu a prompt is a
 * SELECTION (see copilot-store.wire.ts's note on the codex update menu that
 * selected "Update now"). claude's `prepare` block pre-answers its trust
 * dialog, so readiness here should be uneventful; if it is not, ABORT with
 * the pane so a human can see what is actually blocking. */
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
    `claude never reported interactive_ready within ${timeoutMs}ms — refusing to send input into ` +
      `whatever is on screen. claude has a \`prepare\` block, so a trust gate here means the ` +
      `broker-owned config dir under ${STATE_DIR} was not applied.\nPane:\n` +
      (screen.read?.text ?? "(empty)").slice(-800),
  );
}

/** The projects directory this cwd's transcripts land in, derived from the
 * REAL builtin template rather than a copy of it: render with a placeholder
 * id and take the parent. If cli-profiles.ts's claude template ever changes,
 * this follows it instead of silently checking a stale path. */
function projectsDirFor(cwd: string): string {
  const profile = new CliProfiles().get("claude");
  if (!profile?.transcript || profile.transcript.via !== "path") {
    throw new Error("claude's builtin profile no longer declares a 'path' transcript source — update this probe");
  }
  if (!profile.pin) {
    throw new Error("claude's builtin profile no longer declares a `pin` — sub-question 3 is moot, update this probe");
  }
  const configDir = configDirFor(profile, STATE_DIR) ?? join(homedir(), ".claude");
  const rendered = profile.transcript.template
    .replaceAll("{configDir}", configDir)
    .replaceAll("{cwdSlug}", claudeCwdSlug(cwd))
    .replaceAll("{sessionId}", "__probe__");
  return dirname(rendered);
}

/** Transcript records for a cwd, as `{ id -> byte size }`. Size is the cursor
 * that makes "did THIS record grow" answerable without re-reading — the same
 * byte-offset discipline roadmap 30(b) says a usage accumulator will need. */
function recordsIn(dir: string): Record<string, number> {
  if (!existsSync(dir)) return {};
  const out: Record<string, number> = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    out[f.slice(0, -".jsonl".length)] = statSync(join(dir, f)).size;
  }
  return out;
}

/** Only the bytes written after `from` — the phase-1 nonce is already in the
 * record, so a whole-file search would report "reattached" for an agent that
 * started clean and appended nothing. */
function bytesSince(path: string, from: number): string {
  if (!existsSync(path)) return "";
  const buf = readFileSync(path);
  return from >= buf.length ? "" : buf.subarray(from).toString("utf8");
}

type Verdict = "reattached" | "reattached-forked" | "started-clean" | "inconclusive";

/** The 2x2 this probe exists to resolve, and the only place judgement enters.
 *
 * `echoed` — the model produced the nonce it could only know from the earlier
 * conversation. `grew` — the ORIGINAL record gained bytes. `forked` — a new
 * record appeared for this cwd.
 *
 * The two clean corners are unambiguous. The mixed corner (echoed + forked)
 * is the dangerous one and is deliberately NOT folded into "reattached": the
 * context came back but the record moved, which means AgentMeta.sessionId
 * would point at a file that has stopped growing and readTurnState would
 * report a live agent as stalled. That is a different mode-D design (the
 * resumed id must be re-captured after spawn) and it must not be discovered
 * later by a reader going quiet in production.
 *
 * `!echoed && grew` is treated as inconclusive rather than as evidence:
 * bytes can land for reasons unrelated to the question (a session summary,
 * a heartbeat), and calling that a resume would be reading the instrument
 * rather than taking a measurement. */
export function classifyResume(echoed: boolean, grew: boolean, forked: boolean): Verdict {
  if (echoed && grew && !forked) return "reattached";
  if (echoed && forked) return "reattached-forked";
  if (!echoed && (forked || grew)) return "started-clean";
  return "inconclusive";
}

test("WT-11 discovery half: the projects dir resolves and lists records", { skip: !process.env.HERDR_WIRE }, () => {
  // Smoke-test the locating machinery against whatever is already on disk,
  // separately from the spawn half — this is what rules out the WT-1/WT-2
  // instrument failure BEFORE a two-spawn probe spends fifteen minutes
  // reporting zero. An unused cwd must come back empty, not throw.
  const unused = projectsDirFor(realpathSync(mkdtempSync(join(tmpdir(), "hwb-wt11-neg-"))));
  assert.deepEqual(recordsIn(unused), {}, "a never-used cwd must resolve to an empty record set, not an error");
  console.log(`WT-11 projects dir for an unused cwd: ${unused}`);
});

test("WT-11: claude --resume <id> reattaches prior context", { skip: !process.env.HERDR_WIRE }, async () => {
  // realpath: macOS mkdtemp returns /var/..., the CLI records /private/var/...
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hwb-wt11-")));
  const dir = projectsDirFor(cwd);
  const nonce = `wt11-${Math.random().toString(36).slice(2, 10)}`;
  const workspaces: string[] = [];

  try {
    // ── Phase 1: establish a conversation carrying a nonce ───────────────
    const first = (await call("/agents", "POST", { kind: "claude", cwd })) as {
      workspace_id?: string;
      pane_id?: string;
    };
    if (!first.pane_id || !first.workspace_id) throw new Error("spawn returned no pane/workspace id");
    workspaces.push(first.workspace_id);
    await awaitAgentReady(first.pane_id);
    await call(`/agents/${encodeURIComponent(first.pane_id)}/prompt`, "POST", {
      text: `Remember this exact token: ${nonce}. Reply with just the word OK.`,
    });

    // ── Phase 1b: learn the session id the only way available ────────────
    // The broker mints it and returns it from no endpoint (roadmap 31(a)),
    // so the probe reads it off the filesystem: for a fresh cwd exactly one
    // record should appear, and its basename IS the id. This has to happen
    // BEFORE the pane closes, because stop deletes the AgentMeta row that
    // holds it (31(b)) — the probe is forced to demonstrate both gaps just
    // to ask its own question.
    const deadline = Date.now() + 180_000;
    let sessionId: string | undefined;
    while (Date.now() < deadline) {
      const ids = Object.keys(recordsIn(dir));
      if (ids.length > 0) {
        sessionId = ids[0];
        if (ids.length > 1) console.log(`WT-11 WARNING: ${ids.length} records for one fresh cwd: ${ids.join(", ")}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(
      sessionId,
      `FAILING HERE IS AN INSTRUMENT PROBLEM, NOT AN ANSWER: no transcript appeared under ${dir}. ` +
        "Check that the broker applied the prepare block (CLAUDE_CONFIG_DIR) and that " +
        `HERDR_PLUGIN_STATE_DIR matches the running daemon — this probe resolved ${STATE_DIR}.`,
    );
    const record = join(dir, `${sessionId}.jsonl`);

    // Wait for the nonce to actually land, so phase 4 is asking about a
    // conversation that demonstrably happened rather than one that was
    // still in flight when the pane closed.
    let seeded = false;
    while (Date.now() < deadline && !seeded) {
      seeded = existsSync(record) && readFileSync(record, "utf8").includes(nonce);
      if (!seeded) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(seeded, `nonce ${nonce} never reached ${record} — the first turn did not complete, so there is nothing to resume`);
    console.log(`WT-11 session id: ${sessionId}`);
    console.log(`WT-11 record seeded: ${record} (${statSync(record).size} bytes)`);

    // ── Phase 2: cold start — the agent's pane goes away ─────────────────
    await call(`/agents/${encodeURIComponent(first.pane_id)}`, "DELETE");
    const sizeBefore = statSync(record).size;
    const recordsBefore = recordsIn(dir);

    // ── Phase 3: resume, and eat the pin collision (sub-question 3) ───────
    // The broker appends `--session-id <fresh>` because claude has a pin,
    // so agent.start receives BOTH flags. Whether that errors, whether the
    // resume wins, or whether the fresh pin wins is precisely the finding.
    const args = RESUME_SYNTAX.claude(sessionId);
    console.log(`WT-11 resume args (broker will append ${new CliProfiles().get("claude")?.pin?.flag} <fresh-uuid>): ${args.join(" ")}`);
    let spawnError: string | undefined;
    let resumedPane: string | undefined;
    try {
      const second = (await call("/agents", "POST", { kind: "claude", cwd, args })) as {
        workspace_id?: string;
        pane_id?: string;
      };
      if (second.workspace_id) workspaces.push(second.workspace_id);
      resumedPane = second.pane_id;
    } catch (e) {
      spawnError = String(e);
    }
    console.log(`WT-11 resume spawn: ${spawnError ? `FAILED — ${spawnError}` : "accepted"}`);
    assert.ok(
      !spawnError && resumedPane,
      "THIS FAILING IS THE ANSWER TO SUB-QUESTION 3: the resume flag and the pin flag cannot " +
        "coexist on one agent.start, so mode D must suppress the pin when resuming rather than " +
        "appending both (workspace-ops.ts:648). Record that and stop here.",
    );

    // ── Phase 4: ask for something only the old conversation knows ────────
    await awaitAgentReady(resumedPane);
    await call(`/agents/${encodeURIComponent(resumedPane)}/prompt`, "POST", {
      text: "What exact token did I ask you to remember? Reply with just that token, or NONE if you were not told one.",
    });

    let echoed = false;
    let grew = false;
    let forked = false;
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
      const now = recordsIn(dir);
      grew = (now[sessionId] ?? 0) > sizeBefore;
      const fresh = Object.keys(now).filter((id) => !(id in recordsBefore));
      forked = fresh.length > 0;
      // Only bytes written after the resume count — the nonce is already in
      // the original record from phase 1.
      const written = [
        bytesSince(record, sizeBefore),
        ...fresh.map((id) => bytesSince(join(dir, `${id}.jsonl`), 0)),
      ].join("");
      if (written.includes(nonce)) {
        echoed = true;
        break;
      }
      if (grew || forked) await new Promise((r) => setTimeout(r, 2000));
      else await new Promise((r) => setTimeout(r, 1000));
    }

    const verdict = classifyResume(echoed, grew, forked);
    console.log(`WT-11 nonce echoed after resume: ${echoed}`);
    console.log(`WT-11 original record grew: ${grew} (${sizeBefore} -> ${recordsIn(dir)[sessionId] ?? 0} bytes)`);
    console.log(`WT-11 new record appeared: ${forked}`);
    console.log(`WT-11 VERDICT: ${verdict}`);

    // Open question as of 2026-08-30 — this asserts the OUTCOME MODE D NEEDS,
    // and each other verdict is a real answer with its own consequence:
    //
    //   started-clean      the flag is accepted and not honored (the WT-2
    //                      shape). Mode D is impossible for claude; roadmap
    //                      31 closes as won't-fix for this kind.
    //   reattached-forked  context returns but the record moves. Mode D must
    //                      RE-CAPTURE the id after spawn, because the stored
    //                      one now points at a file that stopped growing and
    //                      readTurnState would call a live agent stalled.
    //   inconclusive       nothing measurable happened — rule out the probe
    //                      before recording anything (README: an instrument
    //                      reading zero is not a measurement).
    //
    // Once this is answered, invert the assertion to pin the answer, as WT-2's
    // probe does, so it guards a regression instead of re-asking a settled
    // question.
    assert.equal(
      verdict,
      "reattached",
      `WT-11 answered as "${verdict}" rather than "reattached" — see the consequence table above ` +
        "this assertion and record it in test/wire/README.md and roadmap 31 before changing any code.",
    );
  } finally {
    for (const w of workspaces) {
      await call(`/workspaces/${encodeURIComponent(w)}`, "DELETE").catch(() => undefined);
    }
  }
});
