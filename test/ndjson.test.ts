import test from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, NdjsonDecoder } from "../src/ndjson.js";

test("encodeFrame appends exactly one newline", () => {
  assert.equal(encodeFrame({ a: 1 }), '{"a":1}\n');
});

test("decoder yields frames split across chunks", () => {
  const d = new NdjsonDecoder();
  assert.deepEqual(d.push('{"id":"r1","me'), []);
  assert.deepEqual(d.push('thod":"ping"}\n{"id":"r2"}\n'), [
    { id: "r1", method: "ping" },
    { id: "r2" },
  ]);
});

test("decoder skips blank lines and holds trailing partials", () => {
  const d = new NdjsonDecoder();
  assert.deepEqual(d.push('\n{"x":1}\n{"y":'), [{ x: 1 }]);
  assert.deepEqual(d.push("2}\n"), [{ y: 2 }]);
});

test("decoder throws on malformed JSON line", () => {
  const d = new NdjsonDecoder();
  assert.throws(() => d.push("not json\n"));
});

test("decoder throws when an unterminated line exceeds the 1MB cap", () => {
  const d = new NdjsonDecoder();
  assert.throws(() => d.push("x".repeat(1_048_577)));
});
