import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { claudeCwdSlug } from "../../src/transcript.js";

/** WT-11 sub-question 1 — does `--resume` REATTACH CONTEXT, or merely start
 * clean without erroring?
 *
 * Sub-questions 2, 3 and 4 were answered through the broker and stand:
 * resume FORKS rather than appends, the pin/resume flag collision is real, and
 * the fork lands under the id the broker minted. All three are direct
 * filesystem or argv observations that need no model output. This one cannot
 * be: only a real model saying something it could only know from the earlier
 * conversation distinguishes reattachment from a clean start.
 *
 * **Why this probe exists separately from claude-resume.wire.ts.** That one
 * spawns through the BROKER, whose `prepare` block redirects
 * CLAUDE_CONFIG_DIR, and a claude spawned that way is not authenticated
 * (WT-13). An unauthenticated agent writes `<synthetic>` assistant rows, and
 * on 2026-08-30 this question was answered "yes" against exactly such an
 * agent — a false positive, because `--fork-session` COPIES the parent
 * conversation into the fork, so the nonce is in the file whether or not the
 * model ever produced it. This rig therefore drives claude through herdr
 * DIRECTLY, with the user's own config dir, so the CLI is authenticated. It
 * answers the CLI-level question only; the broker end-to-end path is WT-12's
 * and stays blocked on roadmap 33's deferred half.
 *
 * The measurement is guarded twice over. Phase 1 refuses to continue unless
 * the seed produced REAL model output, and phase 2 accepts only a
 * non-`<synthetic>` assistant row timestamped AFTER the recall prompt went in.
 * A copied line cannot satisfy either.
 */

const SOCK = process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config/herdr/herdr.sock");
/** A directory the user's own claude already trusts, so no trust gate stands
 * in front of the measurement and nothing has to be written into their real
 * config to get past one. */
const CWD = process.env.WT11_CWD ?? process.cwd();
const PROJECTS = join(homedir(), ".claude", "projects", claudeCwdSlug(CWD));

function rpc(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<any> {
  return new Promise((res, rej) => {
    const s = connect(SOCK);
    let buf = "";
    s.on("connect", () => s.write(JSON.stringify({ id: "1", method, params }) + "\n"));
    s.on("data", (d) => {
      buf += d.toString();
      const line = buf.split("\n")[0];
      if (!line) return;
      s.destroy();
      const f = JSON.parse(line);
      f.error ? rej(new Error(`${method}: ${JSON.stringify(f.error)}`)) : res(f.result);
    });
    s.on("error", rej);
    setTimeout(() => rej(new Error(`${method} timed out`)), timeoutMs);
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rows(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}
const ts = (r: Record<string, unknown>): number =>
  typeof r.timestamp === "string" ? Date.parse(r.timestamp) : 0;

/** Identical predicates to claude-resume.wire.ts, deliberately duplicated
 * rather than shared: they are the definition of a valid measurement here,
 * and a probe that imports its own correctness from elsewhere can have it
 * changed underneath. */
function hasRealModelOutput(path: string): boolean {
  return rows(path).some((r) => {
    if (r.type !== "assistant") return false;
    const m = r.message as { model?: unknown } | undefined;
    return typeof m?.model === "string" && m.model !== "<synthetic>";
  });
}
function modelSaidAfter(path: string, needle: string, after: number): boolean {
  return rows(path).some((r) => {
    if (r.type !== "assistant" || ts(r) < after) return false;
    const m = r.message as { model?: unknown } | undefined;
    if (typeof m?.model !== "string" || m.model === "<synthetic>") return false;
    return JSON.stringify(r).includes(needle);
  });
}

/** Never send input into a screen that has not identified itself as ready —
 * into a menu, a prompt is a SELECTION (see the README's codex note).
 *
 * Readiness is herdr's own agent DETECTION here, not `interactive_ready`.
 * Measured 2026-08-31 on herdr 0.8.2: for a claude TYPED into a pane,
 * `agent.list` reports `{agent: "claude", agent_status: "idle"}` and OMITS
 * `interactive_ready` entirely — the key is absent, not false — while a
 * fully-rendered, authenticated claude sat on screen. Waiting on that field
 * therefore never returns on this path. It refines WT-8, which found the
 * typed and `agent.start` paths indistinguishable for detection and status:
 * on this field they differ.
 *
 * Detection plus a known status is a real signal rather than a screen guess —
 * herdr has recognised the CLI and is tracking its state, which is what
 * "there is an agent here to talk to" means. */
async function awaitReady(pane: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await rpc("agent.list", {});
    const row = (list.agents ?? []).find((a: any) => a.pane_id === pane);
    if (row?.interactive_ready === true) return;
    if (row?.agent === "claude" && typeof row?.agent_status === "string") return;
    await sleep(1000);
  }
  const screen = await rpc("pane.read", { pane_id: pane, source: "visible" });
  throw new Error(
    `claude never reported interactive_ready in ${timeoutMs}ms — refusing to type into whatever is ` +
      `on screen. Pane:\n${screen?.read?.text ?? "(empty)"}`,
  );
}

/** Wait until the SEED conversation is visibly restored in the pane.
 *
 * Phase 2 needs a stronger gate than phase 1: a fresh claude has nothing to
 * replay, but a resumed one reads the parent record first, and herdr reports
 * the agent detected well before that finishes. Seeing the seed's own content
 * on screen is proof the replay is done and the input box is live.
 *
 * This is identification, not measurement — the ANSWER is only ever read from
 * the fork's transcript, where a copied line cannot masquerade as a reply. */
async function awaitRestored(pane: string, token: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const screen = await rpc("pane.read", { pane_id: pane, source: "visible" });
    const text: string = screen?.read?.text ?? "";
    if (text.includes(token) && text.includes("ACK")) return;
    await sleep(2000);
  }
  const screen = await rpc("pane.read", { pane_id: pane, source: "visible" });
  throw new Error(
    `the seed conversation never appeared on screen within ${timeoutMs}ms — refusing to send a recall ` +
      `prompt into a session that may not have reattached. Pane:\n${screen?.read?.text ?? "(empty)"}`,
  );
}

async function waitFor(fn: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(2000);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

test("WT-11(1): a resumed claude REATTACHES the earlier conversation", { skip: !process.env.HERDR_WIRE }, async () => {
  const token = `WT11-${randomUUID().slice(0, 8).toUpperCase()}`;
  const seedId = randomUUID();
  const forkId = randomUUID();
  const seedFile = join(PROJECTS, `${seedId}.jsonl`);
  const forkFile = join(PROJECTS, `${forkId}.jsonl`);
  console.log(`cwd      ${CWD}\nprojects ${PROJECTS}\ntoken    ${token}`);

  // ── phase 1: seed a conversation the model actually participates in ──────
  let ws1: string | undefined;
  try {
    const made = await rpc("workspace.create", { cwd: CWD, label: "wt11-seed" });
    const pane = made.root_pane.pane_id;
    ws1 = pane.split(":")[0];
    await sleep(1500);
    // CLAUDE_CODE_CHILD_SESSION disables transcript saving entirely, and this
    // probe's whole instrument IS the transcript — see the README's note.
    await rpc("pane.send_input", {
      pane_id: pane,
      text: `unset CLAUDE_CODE_CHILD_SESSION; claude --session-id ${seedId}`,
      keys: ["Enter"],
    });
    await awaitReady(pane);
    await rpc("pane.send_input", {
      pane_id: pane,
      text: `Remember this token for later: ${token}. Reply with only the word ACK.`,
      keys: ["Enter"],
    });
    await waitFor(() => hasRealModelOutput(seedFile), 180_000, "a REAL assistant row in the seed record");
    console.log(`seed ok: ${seedFile} has real model output`);
  } finally {
    if (ws1) await rpc("workspace.close", { workspace_id: ws1 }).catch((e) => console.log(`cleanup seed: ${e.message}`));
  }

  assert.ok(
    hasRealModelOutput(seedFile),
    "the seed conversation has no REAL model output — every assistant row is <synthetic>. " +
      "That is an unauthenticated CLI, and measuring recall against it is what produced the " +
      "2026-08-30 false positive. Nothing is measurable here; fix auth first.",
  );

  // ── phase 2: resume it and ask for something only phase 1 knows ──────────
  let ws2: string | undefined;
  let askedAt = 0;
  try {
    const made = await rpc("workspace.create", { cwd: CWD, label: "wt11-resume" });
    const pane = made.root_pane.pane_id;
    ws2 = pane.split(":")[0];
    await sleep(1500);
    // The argv shape mode D produces: resume the seed, fork it, and pin the
    // fork under a freshly minted id (WT-11(3)/(4)).
    await rpc("pane.send_input", {
      pane_id: pane,
      text: `unset CLAUDE_CODE_CHILD_SESSION; claude --resume ${seedId} --fork-session --session-id ${forkId}`,
      keys: ["Enter"],
    });
    // NOT agent detection here. Detection fires ~5s in, while claude is still
    // replaying the seed transcript, and a prompt sent into that window is
    // swallowed — the first run of this probe timed out for exactly that
    // reason, with no fork record ever written because no message landed.
    // The restored conversation ON SCREEN is a positive identification of the
    // state we need, which is what the README asks for before sending input.
    await awaitRestored(pane, token);
    askedAt = Date.now();
    // Never names the token. If the answer contains it, the model was given
    // the earlier conversation.
    await rpc("pane.send_input", {
      pane_id: pane,
      text: "What token did I ask you to remember earlier? Reply with only that token.",
      keys: ["Enter"],
    });
    await waitFor(() => modelSaidAfter(forkFile, token, askedAt), 180_000, "the model to answer the recall prompt");
  } finally {
    if (ws2) await rpc("workspace.close", { workspace_id: ws2 }).catch((e) => console.log(`cleanup fork: ${e.message}`));
  }

  const recalled = modelSaidAfter(forkFile, token, askedAt);
  console.log(`\nfork record : ${forkFile}`);
  console.log(`fork rows   : ${rows(forkFile).length}`);
  console.log(`real output : ${hasRealModelOutput(forkFile)}`);
  console.log(`RECALLED    : ${recalled}`);
  assert.ok(
    hasRealModelOutput(forkFile),
    "the resumed conversation produced no real model output — the measurement never happened",
  );
  assert.ok(
    recalled,
    `the resumed model did not produce ${token} after the recall prompt. --resume ACCEPTED the id and ` +
      "the fork copied the record, but the model was not given the earlier conversation — which is " +
      "precisely the WT-2 shape: accepting a flag is not honoring it.",
  );
});
