import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The backend contract, pinned.
 *
 * `localEndpoints` lets a non-herdr backend serve the whole broker (see
 * docs/local-endpoints-seam.md), and an adopter evaluating that asked the
 * obvious question the repo could not answer: WHICH methods must a backend
 * implement? There was no artifact saying so — only src/, which assumes
 * herdr, and FakeHerdr, which assumes it too and enumerates almost nothing
 * because each test registers only the verbs it needs.
 *
 * The doc now lists them. This is what stops the doc from drifting away from
 * the code: it re-derives the surface from src/ on every run and fails if the
 * two disagree in either direction. Add a 19th herdr call and this goes red
 * pointing at the doc; delete the last caller of one and it goes red too. */

const ROOT = join(import.meta.dirname, "..", "..");
const DOC = join(ROOT, "docs", "local-endpoints-seam.md");

/** Called through LocalHerdr.request(). Extracted rather than listed, because
 * a hand-kept list is exactly the artifact that goes stale. */
export function methodLiteralsIn(src: string): Set<string> {
  const out = new Set<string>();
  // Calls wrap across lines, so scan forward from each `.request(` rather than
  // matching a line — a line-wise grep undercounts this by roughly half, which
  // is how the surface was first mis-sized.
  for (const m of src.matchAll(/\.request\(/g)) {
    const arg = src.slice(m.index + ".request(".length, m.index + 400);
    // The first argument must be an identifier or a property access, and the
    // second an IMMEDIATE literal. Both halves of that are load-bearing, and
    // each was wrong once:
    //
    //   too loose — a bare forward scan for the first dotted string attributes
    //   a decoy to the five sites that pass the method as a VARIABLE, in a
    //   tree holding "herdr.sock", "audit.log", "git.read", "auth.self_kick".
    //
    //   too tight — requiring a bare identifier silently drops three real
    //   literal sites that pass `binding.session` or `opts.session`
    //   (http.ts x2, module-api.ts). That direction is the more dangerous one:
    //   it shrinks `called`, so the contract appears to over-state and the
    //   failure messages tell a maintainer to DELETE a row documenting a real
    //   requirement.
    //
    // A call expression in the first position stays out deliberately: a session
    // obtained by calling something is not a shape this code uses.
    const lit = /^\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\s*,\s*"([a-z_]+\.[a-z_]+)"/.exec(arg);
    if (lit) out.add(lit[1]);
  }
  return out;
}

/** Called through LocalHerdr.request(). Extracted rather than listed, because
 * a hand-kept list is exactly the artifact that goes stale. */
function methodsCalledFromSrc(): Set<string> {
  const out = new Set<string>();
  const dir = join(ROOT, "src");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    for (const m of methodLiteralsIn(readFileSync(join(dir, file), "utf8"))) out.add(m);
  }
  return out;
}

/** Used by the attach path directly rather than through request(): the
 * liveness probe and the event channel. A backend needs both. */
const ATTACH_METHODS = ["ping", "events.subscribe"];

/** The contract is the TABLE ROWS, not the file. Matching anywhere in the
 * document was a reachable hole: a row could be deleted and the assertion
 * still passed on an incidental prose mention. Verified, not theorised —
 * deleting agent.explain's row while leaving one backticked mention left all
 * three tests green with the table at 17 rows. */
function methodsClaimedByContract(doc: string): Set<string> {
  const claimed = new Set<string>();
  for (const line of doc.split("\n")) {
    const m = /^\| `([a-z_]+\.[a-z_]+|ping)`/.exec(line);
    if (m) claimed.add(m[1]);
  }
  return claimed;
}

test("every herdr method the broker calls is a row in the seam contract", () => {
  const claimed = methodsClaimedByContract(readFileSync(DOC, "utf8"));
  assert.ok(claimed.size > 0, "no contract table rows found — did the doc's format change?");
  const called = [...methodsCalledFromSrc(), ...ATTACH_METHODS].sort();

  assert.deepEqual(
    called.filter((m) => !claimed.has(m)),
    [],
    `called by src/ but not a ROW in docs/local-endpoints-seam.md — a backend author ` +
      `reading the contract tables would not know to implement them`,
  );
});

test("the seam contract documents no method the broker does not call", () => {
  // The other direction. A contract that over-states is worse than one that
  // under-states: it makes an adopter build something nothing will ever call.
  const called = new Set([...methodsCalledFromSrc(), ...ATTACH_METHODS]);
  const claimed = methodsClaimedByContract(readFileSync(DOC, "utf8"));

  assert.deepEqual(
    [...claimed].filter((m) => !called.has(m)).sort(),
    [],
    "the contract lists methods src/ never calls",
  );
});

test("the contract covers the whole surface, not a sample", () => {
  // A count, so a silent shrink is visible. 16 through request() plus the two
  // attach methods, as of 2026-08-29.
  const called = new Set([...methodsCalledFromSrc(), ...ATTACH_METHODS]);
  assert.equal(
    called.size,
    18,
    `the herdr surface changed size (${called.size} now, 18 documented). Update ` +
      `docs/local-endpoints-seam.md's contract tables and this count together.`,
  );
});

// ── the guard's own guards ───────────────────────────────────────────────
// F6 and F7 were each found by a hand-run mutation and fixed; nothing then
// held those fixes in place. A later "simplification" back to doc.includes(),
// or a re-narrowing of the first-argument pattern, would leave all three
// assertions above green on a correct doc and the regression invisible —
// which is the hazard these very tests exist to prevent, one level up.

test("a dropped table row does not read as documented, even with prose nearby", () => {
  const doc = readFileSync(DOC, "utf8");
  const row = doc.split("\n").find((l) => l.startsWith("| `agent.explain`"));
  assert.ok(row, "fixture row not found — did the contract tables change shape?");

  const mutated = doc
    .replace(`${row}\n`, "")
    .replace(
      "## What a partial backend does",
      "Prose mentioning `agent.explain` must not count.\n\n## What a partial backend does",
    );
  assert.ok(mutated.includes("`agent.explain`"), "fixture must keep a prose mention");
  assert.ok(
    !methodsClaimedByContract(mutated).has("agent.explain"),
    "a dropped row still reads as documented — the guard is matching prose again",
  );
});

test("the extractor takes literal call sites and only those", () => {
  // dynamic first, with the decoys that actually live in src/ around it
  const dynamic = `
    const path = join(dir, "herdr.sock");
    const log = "audit.log";
    return deps.local.request(session, method, params, timeoutMs);
    // "git.read" and "auth.self_kick" appear nearby
  `;
  assert.deepEqual([...methodLiteralsIn(dynamic)], [], "a dynamic site must contribute nothing");

  assert.deepEqual([...methodLiteralsIn('x.request(session, "agent.list", {})')], ["agent.list"]);
  assert.deepEqual(
    [...methodLiteralsIn('x.request(binding.session, "workspace.close", {})')],
    ["workspace.close"],
    "a property-access first arg is a real call site, not a dynamic one",
  );
  assert.deepEqual(
    [...methodLiteralsIn('x.request(\n  session,\n  "pane.split",\n  { a: 1 },\n)')],
    ["pane.split"],
    "calls wrap across lines",
  );
  assert.deepEqual(
    [...methodLiteralsIn('x.request(getSession(id), "agent.list")')],
    [],
    "a call expression in the first position is not a shape this code uses",
  );
});
