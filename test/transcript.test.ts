import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CliProfiles } from "../src/cli-profiles.js";
import { parseTranscript, claudeCwdSlug, decodeBytesRead } from "../src/transcript.js";

const P = new CliProfiles();
const fx = (n: string) => readFileSync(join(import.meta.dirname, "..", "..", "test", "fixtures", "transcripts", n), "utf8");

test("claude: terminal end_turn reads as done, with the last record's time", () => {
  const s = parseTranscript("claude", fx("claude-done.jsonl"), P.get("claude")!);
  assert.equal(s?.state, "done");
  assert.equal(s?.lastRecordAt, Date.parse("2026-08-27T10:00:09.000Z"));
});

test("claude: a dangling tool_use with no result is blocked, not done", () => {
  const s = parseTranscript("claude", fx("claude-blocked.jsonl"), P.get("claude")!);
  assert.equal(s?.state, "blocked");
});

test("claude: a tool_use FOLLOWED by its result is working, not blocked", () => {
  // claude-done.jsonl has tool_use -> tool_result -> end_turn. Truncating
  // the final assistant line leaves a satisfied tool call mid-turn.
  const trimmed = fx("claude-done.jsonl").trim().split("\n").slice(0, 3).join("\n");
  assert.equal(parseTranscript("claude", trimmed, P.get("claude")!)?.state, "working");
});

test("agy: PLANNER_RESPONSE/DONE is done; ASK_QUESTION is blocked; RUNNING is working", () => {
  assert.equal(parseTranscript("agy", fx("agy-done.jsonl"), P.get("agy")!)?.state, "done");
  assert.equal(parseTranscript("agy", fx("agy-blocked.jsonl"), P.get("agy")!)?.state, "blocked");
  assert.equal(parseTranscript("agy", fx("agy-running.jsonl"), P.get("agy")!)?.state, "working");
});

test("agy: a row that is BOTH status RUNNING and a blocked type reads as working", () => {
  // status and type live on the same row and can collide: the question is
  // still streaming out and hasn't reached the user yet, so liveness wins.
  const row =
    '{"step_index":1,"source":"MODEL","type":"ASK_QUESTION","status":"RUNNING","created_at":"2026-08-27T10:00:05Z","content":"still forming a question"}';
  assert.equal(parseTranscript("agy", row, P.get("agy")!)?.state, "working");
});

test("opencode: assistant+time.completed is done; everything else is working", () => {
  const P2 = P.get("opencode")!;
  const done = '{"role":"assistant","time":{"created":1000,"completed":2000}}';
  assert.deepEqual(parseTranscript("opencode", done, P2), { state: "done", lastRecordAt: 2000 });
  const midGen = '{"role":"assistant","time":{"created":1000}}';
  assert.deepEqual(parseTranscript("opencode", midGen, P2), { state: "working", lastRecordAt: 1000 });
  const userTurn = '{"role":"user","time":{"created":1000}}';
  assert.equal(parseTranscript("opencode", userTurn, P2)?.state, "working");
  assert.equal(parseTranscript("opencode", '{"role":"assistant"}', P2), null, "no timestamp = no evidence");
});

test("garbage and empty input return null rather than throwing", () => {
  assert.equal(parseTranscript("claude", "", P.get("claude")!), null);
  assert.equal(parseTranscript("claude", "not json\n{{{", P.get("claude")!), null);
  assert.equal(parseTranscript("agy", "", P.get("agy")!), null);
  assert.equal(parseTranscript("agy", "not json\n{{{", P.get("agy")!), null);
  assert.equal(parseTranscript("opencode", "", P.get("opencode")!), null);
  assert.equal(parseTranscript("opencode", "not json\n{{{", P.get("opencode")!), null);
});

test("a kind with no parser returns null", () => {
  assert.equal(parseTranscript("codex", "{}", { kind: "codex", source: "builtin" }), null);
});

test("claudeCwdSlug replaces both / and . with -", () => {
  assert.equal(claudeCwdSlug("/Users/e/dev/foo"), "-Users-e-dev-foo");
  // observed live: /a/.claude-worktrees/b -> -a--claude-worktrees-b
  assert.equal(claudeCwdSlug("/a/.claude-worktrees/b"), "-a--claude-worktrees-b");
});

// readSync's own return value is the only trustworthy count of what
// landed in the buffer — a short read (a concurrent truncate racing the
// tail read, a network filesystem) leaves the rest of Buffer.alloc's
// zero-fill in place, and decoding the whole allocation would trail NULs
// onto real content: trim() doesn't strip U+0000, so the newest record
// would fail JSON.parse and get silently dropped by jsonLines.
test("decodeBytesRead: a short read is decoded to only the bytes actually read, not the whole allocation", () => {
  const buf = Buffer.alloc(10);
  buf.write("hi", 0, "utf8");
  assert.equal(decodeBytesRead(buf, 2), "hi");
});

test("decodeBytesRead: a full read is unaffected", () => {
  const buf = Buffer.from("hello", "utf8");
  assert.equal(decodeBytesRead(buf, buf.length), "hello");
});
