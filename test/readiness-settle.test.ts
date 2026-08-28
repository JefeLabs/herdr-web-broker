import test from "node:test";
import assert from "node:assert/strict";
import { holdsReady } from "../src/readiness.js";

test("ready across every sample holds", () => {
  assert.equal(holdsReady([true, true, true]), true);
});

test("a CLI that renders then dies does NOT hold", () => {
  assert.equal(holdsReady([true, true, false]), false);
});

test("readiness is a level, not an edge — a single true is not enough", () => {
  assert.equal(holdsReady([true]), false, "one sample cannot demonstrate a hold");
  assert.equal(holdsReady([]), false);
});

test("undefined (herdr did not report the field) is not a hold", () => {
  assert.equal(holdsReady([true, undefined, true]), false);
});
