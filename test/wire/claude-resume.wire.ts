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
  // claude ANSWERED 2026-08-30 (2.1.251): `--resume <id>` is accepted, but
  // NOT alongside the `--session-id` the broker appends for any pinned kind —
  //   Error: --session-id can only be used with --continue or --resume
  //          if --fork-session is also specified.
  // agent.start still returns success, because herdr only types the command;
  // the rejection happens in the CLI, which exits straight back to the shell.
  // So a spawn that "succeeded" and an agent that never existed look the same
  // from the broker's side — see roadmap 31(c).
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

/** Name what is actually on screen instead of guessing.
 *
 * The first version of the throw below asserted a trust gate unconditionally
 * ("the broker-owned config dir was not applied"). On 2026-08-30 that
 * message fired for a pane where the CLI had REJECTED ITS ARGV and exited to
 * the shell — a launch failure reported as a config-dir failure, which is
 * the misleading-instrument problem this directory's README is about. An
 * exited CLI and a waiting dialog need opposite fixes, so they must not
 * share a diagnosis. */
function readinessDiagnosis(text: string): string {
  const err = /^\s*Error:.*$/m.exec(text);
  if (err) {
    return (
      `the CLI EXITED rather than waiting on anything — it printed: ${err[0].trim()}\n` +
      "That is an argv rejection, not a trust gate. Fix the flags, not the config dir."
    );
  }
  if (/do you trust|quick safety check/i.test(text)) {
    return (
      "a TRUST DIALOG is on screen, so the per-directory pre-answer did not cover this cwd — " +
      "check that prepare-workspace.ts's trustProject wrote projects[<cwd>] under the config dir below."
    );
  }
  return "nothing recognised is on screen; the pane dump is the whole diagnostic.";
}

/** Prove the agent is at ITS OWN prompt before sending anything — never
 * pattern-match a screen and press Enter, because into a menu a prompt is a
 * SELECTION (see copilot-store.wire.ts's note on the codex update menu that
 * selected "Update now"). */
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
  const text = screen.read?.text ?? "(empty)";
  throw new Error(
    `claude never reported interactive_ready within ${timeoutMs}ms — refusing to send input into ` +
      `whatever is on screen. Diagnosis: ${readinessDiagnosis(text)}\n` +
      `State dir: ${STATE_DIR}\nPane:\n` +
      text.slice(-900),
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

/** Rows of a JSONL transcript, parse failures skipped. */
function rows(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as unknown;
      if (o && typeof o === "object") out.push(o as Record<string, unknown>);
    } catch {
      // a row being written right now is not evidence either way
    }
  }
  return out;
}

function ts(row: Record<string, unknown>): number {
  const t = row.timestamp;
  return typeof t === "string" ? Date.parse(t) : 0;
}

/** Did a REAL model produce anything in this record?
 *
 * An unauthenticated claude still writes a transcript: it records the user's
 * prompt, emits `<synthetic>` assistant rows carrying its own error, and ends
 * the turn in ~0s. Every byte-level signal in this probe reads that as a
 * conversation. This is the precondition that stops it — on 2026-08-30 the
 * probe answered "reattached" against an agent that was never logged in,
 * because the broker's `prepare` block redirects CLAUDE_CONFIG_DIR and takes
 * the credentials with it. */
function hasRealModelOutput(path: string): boolean {
  return rows(path).some((r) => {
    if (r.type !== "assistant") return false;
    const m = r.message as { model?: unknown } | undefined;
    return typeof m?.model === "string" && m.model !== "<synthetic>";
  });
}

/** Did the model SAY `needle` after `after`, as opposed to it merely being
 * present in the file?
 *
 * The distinction is the whole correctness of this probe. `--fork-session`
 * COPIES the parent conversation into the new record, so a substring search
 * over the fork's bytes finds the phase-1 nonce whether or not the model ever
 * produced it — which is exactly how this probe returned a false "yes".
 * Proven 2026-08-31: a fork made with a post-resume prompt that never
 * mentioned the nonce, by an agent that was not logged in, still contained it
 * on two copied lines, with all three assistant rows `<synthetic>`.
 *
 * So: only ASSISTANT rows, only from a real model, only timestamped after the
 * recall prompt went in. */
function modelSaidAfter(path: string, needle: string, after: number): boolean {
  return rows(path).some((r) => {
    if (r.type !== "assistant" || ts(r) < after) return false;
    const m = r.message as { model?: unknown } | undefined;
    if (typeof m?.model !== "string" || m.model === "<synthetic>") return false;
    return JSON.stringify(r).includes(needle);
  });
}

/** The session id the broker minted for a pane, straight out of its own
 * index. There is no endpoint for this (roadmap 31a) and the row is deleted
 * when the pane closes (31b), so a probe that needs it has to read the state
 * dir, and has to do it while the agent is still running. */
function readPinnedId(pane: string): string | undefined {
  const file = join(STATE_DIR, "agents.json");
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, { sessionId?: string }>>;
    return data.default?.[pane]?.sessionId;
  } catch {
    return undefined;
  }
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
    // PRECONDITION, not a finding: an unauthenticated agent writes a
    // transcript that looks like a conversation and contains no model output
    // at all. Refuse to measure anything rather than answer from it.
    assert.ok(
      hasRealModelOutput(record),
      "the seeded conversation contains no REAL model output — every assistant row is `<synthetic>`, " +
        "which is what an unauthenticated claude writes. The broker's prepare block redirects " +
        "CLAUDE_CONFIG_DIR and takes the credentials with it, so a broker-spawned claude is logged out " +
        "unless a key is supplied (POST .../env ANTHROPIC_API_KEY). Fix that before reading anything " +
        "from this probe: on 2026-08-30 it answered `reattached` in exactly this state, and was wrong.",
    );
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
    // --fork-session is the escape hatch the CLI's own error names, and it is
    // mode D option (b): the fork gets a NEW id, and because that id is the
    // one the BROKER minted via its pin flag, the invariant pin exists for
    // survives a resume. Option (a) — suppress the pin and keep the original
    // id — needs a broker change and is deliberately not probed here.
    const args = [...RESUME_SYNTAX.claude(sessionId), "--fork-session"];
    console.log(`WT-11 resume args (broker appends ${new CliProfiles().get("claude")?.pin?.flag} <fresh-uuid>): ${args.join(" ")}`);
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
    // Says only that herdr TYPED the command. The CLI can still reject the
    // argv and exit — which is exactly what an unforked resume does — and
    // that shows up at readiness below, not here. Do not read this line as
    // "the flags were accepted"; it was misread that way once already.
    console.log(`WT-11 agent.start returned: ${spawnError ? `FAILED — ${spawnError}` : "ok (says nothing about the CLI's argv)"}`);
    assert.ok(!spawnError && resumedPane, `agent.start itself failed, before the CLI was reached: ${spawnError}`);

    // ── Phase 4: ask for something only the old conversation knows ────────
    await awaitAgentReady(resumedPane);

    // With --fork-session the fork gets a NEW id, and mode D option (b)
    // rests on that id being the one the BROKER minted — if it is,
    // AgentMeta.sessionId still points at the live record after a resume
    // and nothing has to be re-captured.
    //
    // Read from the broker's OWN index, not from herdr's agent title. The
    // title was tried first and is the wrong instrument: it is screen-derived,
    // so it carries the argv only while the command line is still visible.
    // It was populated in the run where the CLI REJECTED its flags and exited
    // (the argv sat in the shell scrollback) and empty in both runs where the
    // CLI actually started and its TUI took over the pane — exactly backwards
    // from what the check needs. agents.json holds the minted id directly, and
    // must be read while the agent is ALIVE: closing the pane deletes the row
    // (roadmap 31b), which is why the id could not be recovered afterwards.
    const forkedId = readPinnedId(resumedPane);
    console.log(`WT-11 fresh pin id the broker minted: ${forkedId ?? "(no agents.json row)"}`);
    const askedAt = Date.now();
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
      // NOT a substring search over new bytes: a fork copies the parent
      // conversation in, nonce and all. Only the model's own words, only
      // after the recall prompt.
      const candidates = [record, ...fresh.map((id) => join(dir, `${id}.jsonl`))];
      if (candidates.some((f) => modelSaidAfter(f, nonce, askedAt))) {
        echoed = true;
        break;
      }
      if (grew || forked) await new Promise((r) => setTimeout(r, 2000));
      else await new Promise((r) => setTimeout(r, 1000));
    }

    const verdict = classifyResume(echoed, grew, forked);
    const after = recordsIn(dir);
    const freshIds = Object.keys(after).filter((id) => !(id in recordsBefore));
    console.log(`WT-11 nonce echoed after resume: ${echoed}`);
    console.log(`WT-11 original record grew: ${grew} (${sizeBefore} -> ${after[sessionId] ?? 0} bytes)`);
    console.log(`WT-11 new record appeared: ${forked} ${freshIds.join(", ")}`);
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
    assert.ok(
      echoed,
      `WT-11 SUB-QUESTION 1 ANSWERED "no": verdict "${verdict}". The resumed agent could not produce ` +
        `the token ${nonce} that the earlier conversation was given, so --resume --fork-session does ` +
        "NOT carry prior context and mode D option (b) is dead. Rule out the probe first — check the " +
        "pane reached a prompt and the model was actually asked — then record it in " +
        "test/wire/README.md and roadmap 31 as the WT-2 shape: a flag accepted and not honored.",
    );

    // Sub-question 2 is REPORTED, not asserted: --fork-session forks by
    // construction, so "reattached-forked" is the expected verdict here and
    // says nothing bad. What matters for mode D (b) is narrower — that the
    // forked record carries the id the BROKER minted, so AgentMeta.sessionId
    // still points at the live file after a resume. If it does not, (b) buys
    // nothing over (a) and the id has to be re-captured either way.
    if (forked && forkedId) {
      assert.ok(
        freshIds.includes(forkedId),
        `the fork landed under ${freshIds.join(", ")} but the broker minted ${forkedId} — mode D ` +
          "option (b) does not preserve the broker's knowledge of the session id, so the resumed id " +
          "must be re-captured after spawn regardless of which option ships.",
      );
      console.log(`WT-11 forked record IS the broker-minted id — mode D option (b) is viable`);
    }
  } finally {
    // Cleanup REPORTS. The first version swallowed every failure with
    // `.catch(() => undefined)`, which hid a real one four runs running:
    // closing the workspace's only agent makes herdr reap the workspace, so
    // this DELETE answers `workspace_not_found` and the broker's index row
    // survives forever (roadmap 32). A silent catch made a leak that the
    // orphans endpoint could see look like a clean teardown.
    //
    // It must not THROW — a cleanup failure would mask the test result it
    // runs after — so it logs and carries on to the next workspace.
    for (const w of workspaces) {
      try {
        await call(`/workspaces/${encodeURIComponent(w)}`, "DELETE");
      } catch (e) {
        console.log(`WT-11 cleanup: workspace ${w} NOT closed — ${String(e).split("\n")[0]}`);
      }
    }
  }
});
