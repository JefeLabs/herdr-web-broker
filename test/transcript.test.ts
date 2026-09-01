import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CliProfiles } from "../src/cli-profiles.js";
import { parseTranscript, claudeCwdSlug, decodeBytesRead } from "../src/transcript.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { readTurnState } from "../src/transcript.js";
import { tmpDir } from "./util.js";

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

test("opencode: a [[cli.profiles]] terminal.done override actually takes effect", () => {
  // Roadmap 25(e). parseOpencode ignored its profile entirely, so this
  // override silently no-opped — unlike claude/agy, where the same block is
  // live. The builtin also DECLARED done: ["completed"], which reads like
  // live config but named a FIELD (time.completed), not the vocabulary word
  // the parser branches on. Both halves were misleading.
  const overridden = new CliProfiles({
    profiles: [
      {
        kind: "opencode",
        // an operator deciding that a completed USER row also settles a turn
        terminal: { done: ["assistant", "user"], blocked: [], running: [] },
      },
    ],
  }).get("opencode")!;
  const userDone = '{"role":"user","time":{"created":1000,"completed":2000}}';
  assert.deepEqual(
    parseTranscript("opencode", userDone, overridden),
    { state: "done", lastRecordAt: 2000 },
    "the override must reach the parser",
  );
  // and the default still behaves exactly as before
  assert.equal(parseTranscript("opencode", userDone, P.get("opencode")!)?.state, "working");
});

test("opencode: narrowing terminal.done can withhold done, proving the set is consulted", () => {
  // The complement of the test above: if `done` were still ignored, an
  // assistant row with time.completed would report done regardless.
  const narrowed = new CliProfiles({
    profiles: [{ kind: "opencode", terminal: { done: [], blocked: [], running: [] } }],
  }).get("opencode")!;
  const assistantDone = '{"role":"assistant","time":{"created":1000,"completed":2000}}';
  assert.equal(parseTranscript("opencode", assistantDone, narrowed)?.state, "working");
});

test("opencode: a profile with no terminal block still resolves done for assistant", () => {
  // terminal is optional on the type; the parser must not lose its default.
  const bare = { kind: "opencode" } as unknown as Parameters<typeof parseTranscript>[2];
  const assistantDone = '{"role":"assistant","time":{"created":1000,"completed":2000}}';
  assert.equal(parseTranscript("opencode", assistantDone, bare)?.state, "done");
});

// ── codex (WT-4, answered live 2026-08-29) ────────────────────────────────
const CODEX_META = '{"timestamp":"2026-08-29T14:47:26.766Z","type":"session_meta","payload":{"session_id":"sid-1","cwd":"/work/proj"}}';
const codexRow = (ts: string, payloadType: string) =>
  `{"timestamp":"${ts}","type":"event_msg","payload":{"type":"${payloadType}"}}`;

test("codex: task_complete is done, pinned to that record's timestamp", () => {
  const P2 = P.get("codex")!;
  const text = [
    CODEX_META,
    codexRow("2026-08-29T14:47:30.000Z", "task_started"),
    codexRow("2026-08-29T14:47:51.843Z", "task_complete"),
  ].join("\n");
  const s = parseTranscript("codex", text, P2);
  assert.equal(s?.state, "done");
  assert.equal(s?.lastRecordAt, Date.parse("2026-08-29T14:47:51.843Z"));
});

test("codex: task_started with no completion is working", () => {
  const text = [CODEX_META, codexRow("2026-08-29T14:47:30.000Z", "task_started")].join("\n");
  assert.equal(parseTranscript("codex", text, P.get("codex")!)?.state, "working");
});

test("codex: a prompt appended after a finished turn reads as working, not stale done", () => {
  // Same rule parseClaude follows: pin to the NEWEST state-deciding row, so a
  // new user turn after a task_complete does not read as an already-finished
  // one. Getting this wrong makes ask() return the PREVIOUS turn's answer.
  const text = [
    CODEX_META,
    codexRow("2026-08-29T14:47:51.843Z", "task_complete"),
    codexRow("2026-08-29T14:48:10.000Z", "task_started"),
  ].join("\n");
  const s = parseTranscript("codex", text, P.get("codex")!);
  assert.equal(s?.state, "working");
  assert.equal(s?.lastRecordAt, Date.parse("2026-08-29T14:48:10.000Z"));
});

test("codex: an override of terminal.done takes effect", () => {
  const overridden = new CliProfiles({
    profiles: [{ kind: "codex", terminal: { done: ["item_completed"], blocked: [], running: ["task_started"] } }],
  }).get("codex")!;
  const text = [CODEX_META, codexRow("2026-08-29T14:47:55.000Z", "item_completed")].join("\n");
  assert.equal(parseTranscript("codex", text, overridden)?.state, "done");
});

test("codex: a rollout with no event_msg rows yields no evidence", () => {
  assert.equal(parseTranscript("codex", CODEX_META, P.get("codex")!), null);
});

// ── copilot: sqlite store, structural completion (WT-5) ───────────────────

test("copilot: a non-null assistant_response is done; null is a turn still running", () => {
  // WT-5, answered 2026-09-01 against copilot 1.0.82. The turns row appears on
  // SUBMISSION with assistant_response NULL and is filled in when the turn
  // finishes, so completion here is STRUCTURAL — the presence of a value, not
  // a vocabulary word. That is why copilot's profile declares no `terminal`:
  // word lists would name nothing this parser reads, which is the dead-config
  // trap 25(e) closed for opencode.
  const P2 = P.get("copilot")!;
  const done = JSON.stringify({
    assistant_response: "Hello! I'm the GitHub Copilot CLI, your terminal assistant.",
    timestamp: "2026-09-01T05:05:03.873Z",
  });
  assert.deepEqual(parseTranscript("copilot", done, P2), {
    state: "done",
    lastRecordAt: Date.parse("2026-09-01T05:05:03.873Z"),
  });

  const submitted = JSON.stringify({ assistant_response: null, timestamp: "2026-09-01T05:05:00.000Z" });
  assert.deepEqual(parseTranscript("copilot", submitted, P2), {
    state: "working",
    lastRecordAt: Date.parse("2026-09-01T05:05:00.000Z"),
  });

  // An empty string is not an answer either — a turn that produced nothing has
  // not completed, and treating "" as done would report a finished turn with
  // no reply, which is the shape ask() reads as an answer.
  const empty = JSON.stringify({ assistant_response: "", timestamp: "2026-09-01T05:05:00.000Z" });
  assert.equal(parseTranscript("copilot", empty, P2)?.state, "working");
});

test("copilot: no usable timestamp is no evidence, not a guess", () => {
  const P2 = P.get("copilot")!;
  assert.equal(parseTranscript("copilot", JSON.stringify({ assistant_response: "hi" }), P2), null);
  assert.equal(
    parseTranscript("copilot", JSON.stringify({ assistant_response: "hi", timestamp: "not a date" }), P2),
    null,
  );
  assert.equal(parseTranscript("copilot", "", P2), null);
});

test("copilot: never reports blocked — that axis stays with agent_status", () => {
  // Same contract as opencode: copilot has no live pending-approval store, so
  // a state this parser cannot emit is one it can never wrongly override.
  const P2 = P.get("copilot")!;
  for (const body of [
    { assistant_response: "done", timestamp: "2026-09-01T05:00:00.000Z" },
    { assistant_response: null, timestamp: "2026-09-01T05:00:00.000Z" },
  ]) {
    assert.notEqual(parseTranscript("copilot", JSON.stringify(body), P2)?.state, "blocked");
  }
});

test("copilot: the store is resolved under the BROKER's config dir, not ~/.copilot", () => {
  // The reason the sqlite branch learned {configDir}. copilot's prepare block
  // redirects COPILOT_HOME, so its store moves with the config dir; a reader
  // looking in the home copy would query the USER's own sessions and never see
  // a broker-spawned one. Mutation-found gap: dropping the templating makes
  // every read degrade to null, which is SAFE and therefore silent — no other
  // test noticed.
  const stateDir = tmpDir();
  const dir = join(stateDir, "cli-config", "copilot");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "session-store.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)");
  db.exec("CREATE TABLE turns (id TEXT, session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT)");
  db.exec("INSERT INTO sessions VALUES ('s1', '/work/repo')");
  db.exec("INSERT INTO turns VALUES ('t1', 's1', 0, 'hi', 'hello there', '2026-09-01T05:05:03.873Z')");
  db.close();

  const profile = new CliProfiles().get("copilot")!;
  const state = readTurnState(profile, { kind: "copilot", startedAt: 0 }, "/work/repo", undefined, stateDir);
  assert.deepEqual(state, { state: "done", lastRecordAt: Date.parse("2026-09-01T05:05:03.873Z") });

  // and the unfinished case, through the same real query rather than a fixture
  const db2 = new DatabaseSync(join(dir, "session-store.db"));
  db2.exec("UPDATE turns SET assistant_response = NULL");
  db2.close();
  assert.equal(
    readTurnState(profile, { kind: "copilot", startedAt: 0 }, "/work/repo", undefined, stateDir)?.state,
    "working",
    "a submitted-but-unfinished turn reads as working through the real SQL",
  );
});
