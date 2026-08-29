import test from "node:test";
import assert from "node:assert/strict";

/** WT-1. The tmux path deliberately uses set-buffer + paste-buffer -p
 * (bracketed paste) so a multi-line prompt does not arrive as a series of
 * Enters that submit half-written text. Whether pane.send_input brackets
 * its input is unverified — if it does not, EVERY multi-line prompt
 * through the broker is subtly broken. */
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

/** `pane.read` answers `{ type, read: { text, ... } }` — the text is NESTED.
 * Reading `.text` off the envelope yields undefined, which coerces to "" and
 * makes every assertion below fail as though the pane were empty. That is not
 * hypothetical: it is what this probe did until 2026-08-29, and its failure
 * message accused send_input of a transport bug it does not have. */
async function readPane(pane: string, source: "visible" | "recent"): Promise<string> {
  const res = (await rpc("pane.read", { pane_id: pane, source })) as { read?: { text?: string } };
  return res.read?.text ?? "";
}

/** Prove the login shell is at its prompt before sending anything.
 *
 * A freshly created pane's shell has not necessarily reached its prompt, and
 * input sent into that gap is swallowed with no error — the pane simply reads
 * back empty. WT-7 established that `pane.wait_for_output` matches the pane's
 * OWN echoed input, so a sentinel is a definitive readiness signal rather than
 * a sleep. Without this the probe races the very cold-shell window roadmap 27
 * exists to close. */
async function awaitShellReady(pane: string): Promise<void> {
  const marker = `__wt1_ready_${Date.now()}__`;
  const armed = rpc("pane.wait_for_output", {
    pane_id: pane,
    source: "visible",
    match: { type: "substring", value: marker },
    timeout_ms: 10_000,
  });
  await rpc("pane.send_input", { pane_id: pane, text: `printf '${marker}\n'`, keys: ["Enter"] });
  await armed;
}

test(
  "WT-1: a multi-line prompt survives send_input as ONE submission",
  { skip: !process.env.HERDR_WIRE },
  async () => {
    // A bare shell pane, not an agent: we are testing the transport, and a
    // shell shows unambiguously whether the newlines submitted early. `cat`
    // with a heredoc echoes its body back only if all four lines arrived as
    // one paste; if send_input does NOT bracket, the shell runs `cat` alone,
    // then treats line-one/line-two as separate commands and reports
    // "command not found".
    const created = (await rpc("workspace.create", { cwd: "/tmp" })) as { root_pane?: { pane_id?: string } };
    const pane = created.root_pane?.pane_id;
    if (!pane) throw new Error("workspace.create returned no root pane");
    try {
      await awaitShellReady(pane);
      await rpc("pane.send_input", {
        pane_id: pane,
        text: "cat <<'EOF'\nline-one\nline-two\nEOF",
        keys: ["Enter"],
      });
      await new Promise((r) => setTimeout(r, 2000));
      const text = await readPane(pane, "recent");

      assert.match(text, /line-one/, "the first body line reached the pane");
      assert.match(text, /line-two/, "the second body line reached the pane");
      assert.doesNotMatch(
        text,
        /command not found|not found: line-/i,
        "FAILING THIS ASSERTION IS THE FINDING: send_input does not bracket its " +
          "input, so every multi-line prompt through the broker submits early. " +
          "Fix by switching the send path to a bracketed paste, the way the " +
          "tmux side uses set-buffer + paste-buffer -p.",
      );
    } finally {
      await rpc("workspace.close", { workspace_id: pane.split(":")[0] }).catch(() => undefined);
    }
  },
);
