import test from "node:test";
import assert from "node:assert/strict";

/** WT-8 — does herdr detect an agent that was TYPED into a pane, rather than
 * started through `agent.start`?
 *
 * Asked from outside this repo. smithagents' `RuntimeAdapter.launch()` takes
 * an arbitrary COMMAND STRING, while `agent.start` takes `{name, kind,
 * pane_id, args?}` — a KIND. Two of smithagents' callers cannot be expressed
 * as a kind:
 *
 *   - its dispatcher launches a wrapped one-shot task
 *     (`cmd ; echo $? > file ; …`), which is not an agent at all;
 *   - its warm-session path builds a full command line through a driver.
 *
 * So a herdr-backed runtime would have to launch at least some CLIs by
 * `pane.send_input` instead. The question is whether herdr's agent detection
 * still fires for those panes. If it does, a `HerdrRuntime` gets native
 * `agent_status` for every path and replaces smithagents' screen-scraped
 * status inference. If it does NOT, the dispatcher path stays blind and
 * roughly half the reason to adopt herdr as a runtime evaporates.
 *
 * This is the single largest unknown in that estimate, which is why it is
 * worth an hour of wire time before anyone plans the work.
 *
 * INSTRUMENT DISCIPLINE (test/wire/README.md, "a probe is an instrument"):
 * a bare red here would be ambiguous between "detection does not fire for
 * typed launches" — the finding — and "the CLI is missing / the pane never
 * reached its prompt / a first-run gate ate the input" — the instrument.
 * So the CONTROL runs first: the same CLI, same conditions, started through
 * `agent.start`. If the control does not detect, this probe reports that it
 * could not take a measurement and records NOTHING about the experiment.
 */

const BASE = process.env.HERDR_BASE ?? "http://127.0.0.1:7591";
const TOKEN = process.env.HERDR_TOKEN ?? "";
const S = `${BASE}/v1/instances/runtime/sessions/default`;

/** The CLI under test. `claude` is the one smithagents actually launches, and
 * it is a kind herdr knows, so control and experiment differ ONLY in how the
 * process was started. */
const KIND = process.env.WT8_KIND ?? "claude";
/** The directory the agent is turned loose in. NO DEFAULT, deliberately.
 *
 * This probe starts a REAL agent CLI — real cost, and real read access to
 * whatever it is pointed at. An earlier draft fell back to `$HOME`, which
 * would have run claude across the operator's entire home tree without ever
 * asking. "Already trusted" and "$HOME" are not the same requirement, and the
 * difference is only visible if someone has to name the directory.
 *
 * It is still NOT `mkdtemp`: a fresh directory is what made the WT-2 probe die
 * on agy's first-run trust gate before it reached its own question. So the
 * requirement is a real, already-trusted directory — chosen by a human, not
 * inferred. The repo checkout satisfies both and is the obvious choice. */
const CWD = process.env.WT8_CWD ?? "";

async function rpc(method: string, params: unknown): Promise<unknown> {
  const r = await fetch(`${S}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ method, params }),
  });
  if (!r.ok) throw new Error(`${method}: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { result: unknown }).result;
}

interface AgentEntry {
  pane_id?: string;
  agent?: string;
  agent_status?: string;
  [k: string]: unknown;
}

async function newPane(): Promise<string> {
  const created = (await rpc("workspace.create", { cwd: CWD })) as { root_pane: { pane_id: string } };
  return created.root_pane.pane_id;
}

/** WT-7's answer, reused: `pane.wait_for_output` matches the pane's own echo,
 * so a sentinel proves the login shell is at its prompt AND executing. Without
 * this the experiment races the cold-shell window and would look like a
 * detection failure. */
async function awaitShell(pane: string): Promise<void> {
  // The marker must be JOINED by the shell, not present in the line we type.
  // `printf '%s%s\n' __p_ 123` echoes with a space and PRINTS without one, so
  // matching the joined form proves the shell EXECUTED the line.
  //
  // A sentinel whose marker appears verbatim in its own command — e.g.
  // `printf '__p_123__\n'` matched on `__p_123__` — matches the ECHO, since
  // WT-7 established the matcher reads the rendered screen. That proves the
  // input was DELIVERED, never that the shell was ready. Measured on a cold
  // pane: the verbatim form matched in 107ms with matched_line equal to the
  // typed command, and agent.start immediately answered agent_pane_busy; this
  // joined form matched in 520ms and agent.start succeeded.
  const n = `${Date.now()}`;
  const expect = `__wt8_ready_${n}`;
  const waiting = rpc("pane.wait_for_output", {
    pane_id: pane,
    source: "visible",
    match: { type: "substring", value: expect },
    timeout_ms: 15_000,
  });
  await rpc("pane.send_input", { pane_id: pane, text: `printf '%s%s\\n' __wt8_ready_ ${n}`, keys: ["Enter"] });
  await waiting;
}

/** Poll `agent.list` for an entry bound to `pane`. Detection is asynchronous
 * (herdr emits `pane.agent_detected`), so absence is only meaningful after a
 * deadline generous enough for a TUI to paint its first frame. */
async function detectIn(pane: string, timeoutMs: number): Promise<AgentEntry | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = (await rpc("agent.list", {})) as { agents?: AgentEntry[] };
    const hit = (list.agents ?? []).find((a) => a.pane_id === pane);
    if (hit) return hit;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function screen(pane: string): Promise<string> {
  try {
    const r = (await rpc("pane.read", { pane_id: pane, source: "visible" })) as { read?: { text?: string } };
    return r.read?.text ?? "";
  } catch {
    return "(pane.read failed)";
  }
}

const close = (pane: string) =>
  rpc("workspace.close", { workspace_id: pane.split(":")[0] }).catch(() => undefined);

test("WT-8: herdr detects an agent typed into a pane, not only one started via agent.start", { skip: !process.env.HERDR_WIRE }, async (t) => {
  // FAIL, never skip. A skip here would be indistinguishable from a probe
  // that ran and found nothing — and a measurement that never ran looks
  // exactly like a clean result. The operator asked for HERDR_WIRE, so they
  // want a measurement; refusing loudly is the only honest answer.
  assert.ok(
    CWD,
    "WT8_CWD is not set, and this probe has no default on purpose. It starts a REAL agent CLI " +
      "with real cost and real read access to the directory it is given. Name the directory " +
      "explicitly — an already-trusted one, not a fresh mkdtemp (a fresh dir trips first-run " +
      "trust gates, which is what killed the WT-2 probe). The repo checkout is the obvious " +
      "choice:\n\n  WT8_CWD=$PWD HERDR_WIRE=1 node --test dist/test/wire/agent-detect.wire.js",
  );

  let controlPane = "";
  let typedPane = "";

  try {
    // ── CONTROL ──────────────────────────────────────────────────────────
    // Same CLI, same cwd, started the blessed way. This establishes that
    // detection works AT ALL here before the experiment is allowed to mean
    // anything.
    controlPane = await newPane();
    await awaitShell(controlPane);
    await rpc("agent.start", { name: `wt8-control-${Date.now()}`, kind: KIND, pane_id: controlPane });
    const control = await detectIn(controlPane, 30_000);

    assert.ok(
      control,
      `INSTRUMENT FAILURE, NOT A FINDING: agent.start(${KIND}) in ${CWD} produced no agent.list ` +
        `entry for its own pane within 30s, so this probe cannot measure anything about typed ` +
        `launches. Rule out the instrument before recording: is ${KIND} on PATH for the pane's ` +
        `shell, did a first-run gate take the screen, is the cwd trusted? Do NOT enter a WT-8 ` +
        `answer in test/wire/README.md from this run.\n\npane:\n${await screen(controlPane)}`,
    );
    t.diagnostic(`control detected: agent=${control.agent} status=${control.agent_status}`);

    // ── EXPERIMENT ───────────────────────────────────────────────────────
    // Identical in every respect except the launch mechanism: the CLI is
    // TYPED into the pane's shell, the way a command-string runtime would
    // have to launch it.
    typedPane = await newPane();
    await awaitShell(typedPane);
    await rpc("pane.send_input", { pane_id: typedPane, text: KIND, keys: ["Enter"] });
    const typed = await detectIn(typedPane, 30_000);

    assert.ok(
      typed,
      `FAILING THIS IS THE FINDING: the control detected but a TYPED ${KIND} did not, within 30s. ` +
        `herdr's detection is bound to agent.start, so a command-string runtime gets no ` +
        `agent_status for panes it launches itself. Consequence for the smithagents HerdrRuntime ` +
        `estimate: the dispatcher path keeps today's screen-scraped status inference, and only the ` +
        `warm-session path (decomposable into kind+args) gains native status. Record that against ` +
        `WT-8 and re-cost before planning the adapter.\n\npane:\n${await screen(typedPane)}`,
    );

    // Presence is not the prize — STATUS is. A detected agent stuck at
    // `unknown` would still leave smithagents inferring from the screen.
    assert.ok(
      typeof typed.agent_status === "string" && typed.agent_status.length > 0,
      `PARTIAL FINDING: a typed ${KIND} was detected (agent=${typed.agent}) but carries no ` +
        `agent_status, so detection alone does not replace status inference. Record the shape ` +
        `seen: ${JSON.stringify(typed)}`,
    );

    t.diagnostic(`typed detected: agent=${typed.agent} status=${typed.agent_status}`);
    t.diagnostic("WT-8 ANSWERED: detection is not bound to agent.start — a HerdrRuntime may launch by send_input");
  } finally {
    if (controlPane) await close(controlPane);
    if (typedPane) await close(typedPane);
  }
});
