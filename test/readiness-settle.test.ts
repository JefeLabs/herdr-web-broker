import test from "node:test";
import assert from "node:assert/strict";
import { holdsReady } from "../src/readiness.js";

test("ready across every sample holds", () => {
  assert.equal(holdsReady([true, true, true]), true);
});

test("a CLI that renders then dies does NOT hold", () => {
  assert.equal(holdsReady([true, true, false]), false);
});

test("undefined (herdr did not report the field) does not fail the hold", () => {
  assert.equal(holdsReady([true, undefined, true]), true);
});

// Sample i=0 is taken immediately after agent.start, while herdr can
// still be in its normal launch_pending phase — a `false` there is not
// evidence of anything dying, since nothing was ever ready yet to stop
// being ready.
test("a false that never follows a true is a healthy slow start, not a death", () => {
  assert.equal(holdsReady([false, true, true]), true);
});

test("a false that follows a true is exactly 'rendered then died'", () => {
  assert.equal(holdsReady([true, false]), false);
});
