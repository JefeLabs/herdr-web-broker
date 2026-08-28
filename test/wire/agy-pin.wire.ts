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
const S = `${BASE}/instances/runtime/sessions/default`;

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

test(
  "WT-2: agy --conversation <fresh-uuid> mints that id as a new conversation",
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
      // Give agy something to actually do — an unprompted agent may never
      // touch its own conversation store at all.
      await call(`/agents/${encodeURIComponent(pane)}/prompt`, "POST", { text: "say hello" });

      const path = template.replaceAll("{home}", process.env.HOME ?? "").replaceAll("{sessionId}", freshId);
      const deadline = Date.now() + 15_000;
      let minted = false;
      while (Date.now() < deadline) {
        if (existsSync(path)) {
          minted = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      assert.equal(
        minted,
        true,
        "FAILING THIS ASSERTION IS THE FINDING, NOT A BUG: agy did not create a " +
          "transcript under the id passed to --conversation, so the flag does not " +
          "mint a fresh conversation. agy stays on cwd-map + startedAt discovery " +
          "(cli-profiles.ts's agy profile keeps no `pin` entry) — this is a " +
          "recorded answer, not something to fix.",
      );
    } finally {
      await call(`/workspaces/${encodeURIComponent(workspaceId)}`, "DELETE").catch(() => undefined);
    }
  },
);
