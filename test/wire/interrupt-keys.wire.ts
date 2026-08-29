import test from "node:test";
import assert from "node:assert/strict";

/** WT-9 — does `pane.send_input`'s `keys` array accept `"C-c"`, and does it
 * actually interrupt?
 *
 * Asked from outside this repo. smithagents' `RuntimeAdapter.sendKeys()` is
 * fed tmux key NAMES, and two live call sites send `"C-c"`
 * (`agent-sessions.ts:240` to interrupt a running agent, `:285` as a courtesy
 * before `kill`). A herdr-backed runtime has to map that onto
 * `pane.send_input {keys: [...]}`.
 *
 * The doubt is specific, not idle: this repo's own SDK deliberately does NOT
 * use C-c. `packages/client/src/agent.ts:118` calls Escape "the portable hard
 * interrupt" and re-prompts after it. That reads like a considered choice —
 * Escape cancels a TUI's turn, C-c signals the process — but the reasoning is
 * not written down, and neither is herdr's accepted key vocabulary. Three
 * outcomes are possible and they lead to different code:
 *
 *   1. C-c accepted and interrupts   -> sendKeys maps straight across.
 *   2. C-c REJECTED by herdr         -> the runtime must translate key names,
 *                                       and smithagents' callers need a
 *                                       vocabulary they can rely on.
 *   3. C-c accepted but does nothing -> the worst case: a silent no-op, where
 *                                       interrupt appears wired and is not.
 *
 * Outcome 3 is why this cannot be settled by reading the schema. Only a live
 * pane distinguishes "accepted" from "effective".
 *
 * INSTRUMENT DISCIPLINE: the probe first proves it can SEE the difference
 * between an interrupted and a blocked shell, using a negative control —
 * while `sleep` holds the pane, the marker must NOT appear. Without that
 * control, a marker showing up after C-c could just as easily mean the sleep
 * had already ended, and a marker missing could mean the reader is broken.
 */

const BASE = process.env.HERDR_BASE ?? "http://127.0.0.1:7591";
const TOKEN = process.env.HERDR_TOKEN ?? "";
const S = `${BASE}/v1/instances/runtime/sessions/default`;

async function rpc(method: string, params: unknown): Promise<unknown> {
  const r = await fetch(`${S}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ method, params }),
  });
  if (!r.ok) throw new Error(`${method}: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { result: unknown }).result;
}

async function readPane(pane: string): Promise<string> {
  const r = (await rpc("pane.read", { pane_id: pane, source: "recent" })) as { read?: { text?: string } };
  return r.read?.text ?? "";
}

/** A marker whose OUTPUT differs from its own ECHO. `printf '%s%s\n' M_ 123`
 * echoes with a space between the arguments and prints without one, so
 * searching for the JOINED form proves the shell EXECUTED the line rather
 * than merely displaying it. Getting this wrong is how a probe reports
 * "interrupt worked" off a screen that only contains the typed command. */
function marker(): { send: string; expect: string } {
  const n = `${Date.now()}`;
  return { send: `printf '%s%s\\n' M_ ${n}`, expect: `M_${n}` };
}

async function ran(pane: string): Promise<boolean> {
  const m = marker();
  await rpc("pane.send_input", { pane_id: pane, text: m.send, keys: ["Enter"] });
  await new Promise((r) => setTimeout(r, 2500));
  return (await readPane(pane)).includes(m.expect);
}

/** Send a bare key with no text. The parameter contract for that is not
 * documented, so try the natural shape and fall back — and report which one
 * herdr actually took, since the runtime will need to know. */
async function sendKey(pane: string, key: string): Promise<{ ok: true; shape: string } | { ok: false; error: string }> {
  try {
    await rpc("pane.send_input", { pane_id: pane, keys: [key] });
    return { ok: true, shape: "{pane_id, keys}" };
  } catch (e) {
    const first = String(e);
    try {
      await rpc("pane.send_input", { pane_id: pane, text: "", keys: [key] });
      return { ok: true, shape: '{pane_id, text:"", keys}' };
    } catch (e2) {
      return { ok: false, error: `${first} | with empty text: ${String(e2)}` };
    }
  }
}

test("WT-9: pane.send_input keys accepts C-c and interrupts a running command", { skip: !process.env.HERDR_WIRE }, async (t) => {
  const created = (await rpc("workspace.create", { cwd: "/tmp" })) as { root_pane: { pane_id: string } };
  const pane = created.root_pane.pane_id;

  try {
    // Shell readiness first (WT-7's sentinel), so nothing below races the
    // cold login shell and reads as an interrupt failure.
    // Joined marker, for the same reason `ran()` uses one: a marker that
    // appears verbatim in the line being typed matches the ECHO, proving
    // delivery rather than readiness. Measured: the verbatim form matches on
    // a cold pane in ~107ms and agent.start still answers agent_pane_busy.
    const n = `${Date.now()}`;
    const ready = `__wt9_ready_${n}`;
    const waiting = rpc("pane.wait_for_output", {
      pane_id: pane,
      source: "visible",
      match: { type: "substring", value: ready },
      timeout_ms: 15_000,
    });
    await rpc("pane.send_input", { pane_id: pane, text: `printf '%s%s\\n' __wt9_ready_ ${n}`, keys: ["Enter"] });
    await waiting;

    // ── NEGATIVE CONTROL ─────────────────────────────────────────────────
    // Occupy the shell, then prove the instrument can tell that it is
    // occupied. If the marker runs here, `sleep` is not blocking the pane
    // and nothing below would mean anything.
    await rpc("pane.send_input", { pane_id: pane, text: "sleep 300", keys: ["Enter"] });
    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(
      await ran(pane),
      false,
      "INSTRUMENT FAILURE, NOT A FINDING: a marker executed while `sleep 300` should have been " +
        "holding the pane. The probe cannot distinguish an interrupted shell from a busy one, so " +
        "any C-c result below would be meaningless. Rule out the instrument before recording.",
    );

    // ── EXPERIMENT ───────────────────────────────────────────────────────
    const sent = await sendKey(pane, "C-c");

    assert.ok(
      sent.ok,
      `FINDING (outcome 2): herdr REJECTED keys:["C-c"] outright — ${sent.ok ? "" : sent.error}. ` +
        `smithagents' sendKeys cannot pass tmux key names through; a HerdrRuntime must translate ` +
        `them, and the accepted vocabulary needs recording here before the adapter is written. ` +
        `Check what this repo's own SDK does instead (packages/client/src/agent.ts:118 uses ` +
        `Escape) and whether that is equivalent for the agent CLIs smithagents drives.`,
    );
    t.diagnostic(`C-c accepted via ${sent.ok ? sent.shape : ""}`);

    await new Promise((r) => setTimeout(r, 1000));

    assert.ok(
      await ran(pane),
      "FINDING (outcome 3 — the silent one): herdr ACCEPTED keys:[\"C-c\"] without error, but the " +
        "shell stayed blocked, so the key was delivered and did nothing. This is the dangerous " +
        "result: a HerdrRuntime would look correctly wired while interrupt silently no-ops, and " +
        "smithagents' agent-sessions.ts:240 would stop working with no error anywhere. Record it " +
        "against WT-9 and use Escape (this repo's portable interrupt) instead.",
    );

    t.diagnostic("WT-9 ANSWERED: C-c is accepted AND effective — sendKeys maps straight across");

    // ── FREE SECOND DATA POINT ───────────────────────────────────────────
    // What Escape does on a plain shell, recorded because it is the key this
    // repo's SDK chose and the runtime may need both.
    const esc = await sendKey(pane, "Escape");
    t.diagnostic(`Escape on a shell pane: ${esc.ok ? `accepted via ${esc.shape}` : `rejected — ${esc.error}`}`);
  } finally {
    await rpc("workspace.close", { workspace_id: pane.split(":")[0] }).catch(() => undefined);
  }
});
