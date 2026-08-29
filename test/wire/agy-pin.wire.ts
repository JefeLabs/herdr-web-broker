import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliProfiles } from "../../src/cli-profiles.js";

/** WT-2. agy has no verified launch flag that PINS a fresh session id the
 * way claude's --session-id and opencode's --session do (cli-profiles.ts's
 * builtin profile). --conversation is known to RESUME an existing id; this
 * probe asks the open question: does `agy --conversation <fresh-uuid>`
 * MINT a conversation under that exact id, or reject/ignore it? A mint
 * turns agy's discovery from a cwd -> id cache lookup (last-write-wins,
 * collision-prone across two agents in one cwd) into the same
 * launch-time-known path claude and opencode already get. */
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

async function rpc(method: string, params: unknown): Promise<unknown> {
  const res = (await call("/rpc", "POST", { method, params })) as { result?: unknown };
  return res?.result;
}

/** Clear agy's first-run permission gate.
 *
 * agy (Antigravity CLI) asks "Do you trust the contents of this project?" the
 * first time it sees a directory. This probe spawns into a fresh mkdtemp, so
 * it hits that gate on EVERY run — the agent never becomes active and the
 * prompt below fails `agent_not_ready` long before the actual question is
 * reached. That is what this probe did until 2026-08-29: it could not answer
 * WT-2 even in principle. The default selection is "Yes, I trust this
 * folder", so a bare Enter clears it. */
async function clearTrustGate(pane: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const res = (await rpc("pane.read", { pane_id: pane, source: "visible" })) as { read?: { text?: string } };
    if (/trust the contents/i.test(res.read?.text ?? "")) {
      await rpc("pane.send_input", { pane_id: pane, text: "", keys: ["Enter"] });
      await new Promise((r) => setTimeout(r, 6000));
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

test(
  "WT-2: agy --conversation <fresh-uuid> does NOT mint that id (answered 2026-08-29)",
  { skip: !process.env.HERDR_WIRE },
  async () => {
    // Read the path template off the real builtin profile rather than
    // duplicating the literal here — if cli-profiles.ts's agy.transcript
    // template ever changes, this probe changes with it instead of
    // silently checking a stale path.
    const profiles = new CliProfiles();
    const agy = profiles.get("agy");
    if (!agy?.transcript || agy.transcript.via !== "map") {
      throw new Error("agy's builtin profile no longer declares a 'map' transcript source — update this probe");
    }
    const template = agy.transcript.template;

    const freshId = randomUUID();
    const cwd = mkdtempSync(join(tmpdir(), "hwb-wt2-"));

    const spawned = (await call("/agents", "POST", {
      kind: "agy",
      cwd,
      args: ["--conversation", freshId],
    })) as { workspace_id?: string; pane_id?: string };
    const pane = spawned.pane_id;
    const workspaceId = spawned.workspace_id;
    if (!pane || !workspaceId) throw new Error("agents spawn returned no pane/workspace id");

    try {
      await clearTrustGate(pane);
      // Give agy something to actually do — an unprompted agent may never
      // touch its own conversation store at all.
      await call(`/agents/${encodeURIComponent(pane)}/prompt`, "POST", { text: "say hello" });

      const path = template.replaceAll("{home}", process.env.HOME ?? "").replaceAll("{sessionId}", freshId);
      const deadline = Date.now() + 45_000;
      let minted = false;
      while (Date.now() < deadline) {
        if (existsSync(path)) {
          minted = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      // ANSWERED 2026-08-29 against agy on herdr 0.8.2: agy ACCEPTS the flag
      // (it appears in the terminal title) but mints nothing — no transcript
      // at the templated path within 45s, and last_conversations.json never
      // learns the id. So agy stays on cwd-map + startedAt discovery and
      // cli-profiles.ts's agy profile keeps no `pin` entry.
      //
      // The assertion is therefore inverted from the original: it now pins the
      // ANSWER rather than the question. A probe that fails forever to record a
      // negative is indistinguishable from a broken probe — this one goes red
      // only if agy STARTS minting, which is precisely when 25(d) becomes
      // closable and someone needs to know.
      assert.equal(
        minted,
        false,
        "agy NOW MINTS a conversation under --conversation <fresh-uuid>, which it " +
          "did not on 2026-08-29. This is good news, not a regression: agy can move " +
          "off cwd-map discovery onto a launch-time-known path like claude's " +
          "--session-id, which closes roadmap 25(d)'s concurrent-same-cwd collision. " +
          "Add a `pin` entry to cli-profiles.ts's agy profile and update WT-2.",
      );
    } finally {
      await call(`/workspaces/${encodeURIComponent(workspaceId)}`, "DELETE").catch(() => undefined);
    }
  },
);
