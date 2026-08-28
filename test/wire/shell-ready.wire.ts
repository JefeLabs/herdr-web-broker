import test from "node:test";
import assert from "node:assert/strict";

/** WT-7 — does `pane.wait_for_output` match the pane's OWN echoed input,
 * or only output a program wrote?
 *
 * The whole spawn-readiness design (docs/superpowers/specs/
 * 2026-08-28-spawn-readiness-design.md) rests on this. It replaces the
 * fixed 300ms settle before `agent.start` with a sentinel: push
 * `printf '__herdr_ready_<id>__'` through the PTY and wait for it to come
 * back. When it echoes, the shell is provably at its prompt AND executing
 * commands — shell-agnostic, no prompt-pattern guessing.
 *
 * If the matcher reads the RENDERED SCREEN (as `pane.read` does), the
 * echoed line is visible and the design works. If it taps a program
 * output stream instead, the sentinel may never match and the whole thing
 * degrades to today's behavior — correct, but pointless.
 *
 * Inference before running (from the API's shape, not from a probe):
 * `pane.wait_for_output` takes `source: "visible" | "recent"` — the same
 * vocabulary `pane.read` takes, where `visible` is the live screen and
 * `recent` is scrollback. A matcher tapping a program-output stream would
 * have no use for a screen/scrollback distinction. That points hard at
 * "rendered buffer", i.e. the sentinel works. This test is what turns
 * that into a fact.
 *
 * Answering this is a PRECONDITION for building the feature, in the same
 * way WT-3 dissolved the `opencode export` approach before anyone
 * implemented against it. */

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

test("WT-7: pane.wait_for_output matches the pane's own echoed input", { skip: !process.env.HERDR_WIRE }, async () => {
  const marker = `__herdr_ready_${Math.floor(Date.now() / 1000)}__`;
  const created = (await rpc("workspace.create", { cwd: "/tmp" })) as { root_pane: { pane_id: string } };
  const pane = created.root_pane.pane_id;

  try {
    // Arm the matcher BEFORE sending, so a fast echo cannot land in the
    // gap between send and wait and make a working matcher look broken.
    const waiting = rpc("pane.wait_for_output", {
      pane_id: pane,
      source: "visible",
      match: { type: "substring", value: marker },
      timeout_ms: 10_000,
    });

    await rpc("pane.send_input", { pane_id: pane, text: `printf '${marker}\\n'`, keys: ["Enter"] });

    const r = (await waiting) as { matched_line?: string };

    assert.ok(
      r && typeof r.matched_line === "string" && r.matched_line.includes(marker),
      "FAILING THIS IS THE FINDING: pane.wait_for_output did not match the pane's own echoed " +
        "input within 10s. The spawn-readiness sentinel design is NOT viable as written — the " +
        "matcher is not reading the rendered screen. Fall back to the variant noted in the spec: " +
        "make the sentinel a command whose STDOUT is the marker in a way that survives whatever " +
        "stream the matcher taps, or abandon the sentinel and keep the agent_pane_busy retry as " +
        "the only readiness mechanism.",
    );

    // Second question, free while we are here: does it also match from
    // `recent` (scrollback)? If the sentinel scrolls off the visible
    // screen on a busy pane, `visible` alone would miss it — which
    // decides whether spawn should ask for `recent` instead.
    const again = (await rpc("pane.wait_for_output", {
      pane_id: pane,
      source: "recent",
      match: { type: "substring", value: marker },
      timeout_ms: 5_000,
    })) as { matched_line?: string };
    assert.ok(
      again && typeof again.matched_line === "string" && again.matched_line.includes(marker),
      "matched on `visible` but NOT on `recent` — spawn must use source:visible, and a sentinel " +
        "that scrolls off before the wait is armed would be missed. Note it in the spec.",
    );
  } finally {
    await rpc("workspace.close", { workspace_id: pane.split(":")[0] }).catch(() => undefined);
  }
});
