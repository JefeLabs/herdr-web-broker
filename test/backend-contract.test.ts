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
function methodsCalledFromSrc(): Set<string> {
  const out = new Set<string>();
  const dir = join(ROOT, "src");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(dir, file), "utf8");
    // Calls wrap across lines, so scan forward from each `.request(` rather
    // than matching a single line — a line-wise grep undercounts this by
    // roughly half, which is how the surface was first mis-sized.
    for (const m of src.matchAll(/\.request\(/g)) {
      const lit = /"([a-z_]+\.[a-z_]+)"/.exec(src.slice(m.index, m.index + 400));
      if (lit) out.add(lit[1]);
    }
  }
  return out;
}

/** Used by the attach path directly rather than through request(): the
 * liveness probe and the event channel. A backend needs both. */
const ATTACH_METHODS = ["ping", "events.subscribe"];

test("every herdr method the broker calls is documented in the seam contract", () => {
  const doc = readFileSync(DOC, "utf8");
  const called = [...methodsCalledFromSrc(), ...ATTACH_METHODS].sort();

  const undocumented = called.filter((m) => !doc.includes(`\`${m}\``));
  assert.deepEqual(
    undocumented,
    [],
    `these methods are called by src/ but absent from docs/local-endpoints-seam.md — ` +
      `a backend author reading the contract would not know to implement them`,
  );
});

test("the seam contract documents no method the broker does not call", () => {
  // The other direction. A contract that over-states is worse than one that
  // under-states: it makes an adopter build something nothing will ever call.
  const doc = readFileSync(DOC, "utf8");
  const called = new Set([...methodsCalledFromSrc(), ...ATTACH_METHODS]);

  // Only the contract tables, so prose mentioning a method in passing is not
  // read as a requirement.
  const claimed = new Set<string>();
  for (const line of doc.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const m = /^\| `([a-z_]+\.[a-z_]+|ping)`/.exec(line);
    if (m) claimed.add(m[1]);
  }

  assert.ok(claimed.size > 0, "no contract table rows found — did the doc's format change?");
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
