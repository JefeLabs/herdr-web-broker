import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CliProfiles } from "../src/cli-profiles.js";
import { readTurnState, claudeCwdSlug } from "../src/transcript.js";
import { tmpDir } from "./util.js";

const P = new CliProfiles();
const DONE_LINE =
  '{"type":"assistant","timestamp":"2026-08-27T10:00:09.000Z","message":{"role":"assistant","stop_reason":"end_turn"}}';

test("claude: a pinned session id resolves to a templated path and parses", () => {
  const home = tmpDir();
  const cwd = "/work/proj";
  const dir = join(home, ".claude", "projects", claudeCwdSlug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sid-1.jsonl"), DONE_LINE + "\n");

  const s = readTurnState(P.get("claude")!, { sessionId: "sid-1", kind: "claude", startedAt: 0 }, cwd, home);
  assert.equal(s?.state, "done");
});

test("agy: the cwd->id cache map resolves the transcript without a pin flag", () => {
  const home = tmpDir();
  const cwd = "/work/proj";
  mkdirSync(join(home, ".gemini", "antigravity-cli", "cache"), { recursive: true });
  writeFileSync(
    join(home, ".gemini", "antigravity-cli", "cache", "last_conversations.json"),
    JSON.stringify({ [cwd]: "conv-9" }),
  );
  const logs = join(home, ".gemini", "antigravity-cli", "brain", "conv-9", ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    join(logs, "transcript.jsonl"),
    '{"step_index":1,"source":"MODEL","type":"ASK_QUESTION","status":"DONE","created_at":"2026-08-27T10:00:06Z"}\n',
  );

  const s = readTurnState(P.get("agy")!, { kind: "agy", startedAt: 0 }, cwd, home);
  assert.equal(s?.state, "blocked");
});

test("opencode: an unpinned session resolves through session.directory", () => {
  const home = tmpDir();
  const dbDir = join(home, ".local", "share", "opencode");
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(join(dbDir, "opencode.db"));
  db.exec("CREATE TABLE session (id TEXT, directory TEXT)");
  db.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
  db.exec("INSERT INTO session VALUES ('ses_1', '/work/proj')");
  db.exec(`INSERT INTO message VALUES ('m1','ses_1',1,'{"role":"assistant","time":{"created":1,"completed":2}}')`);
  db.close();

  const s = readTurnState(P.get("opencode")!, { kind: "opencode", startedAt: 0 }, "/work/proj", home);
  assert.equal(s?.state, "done");
  assert.equal(s?.lastRecordAt, 2);
});

test("missing files and profiles without a transcript source return null", () => {
  const home = tmpDir();
  assert.equal(readTurnState(P.get("claude")!, { sessionId: "nope", kind: "claude", startedAt: 0 }, "/x", home), null);
  assert.equal(readTurnState(P.get("codex")!, { kind: "codex", startedAt: 0 }, "/x", home), null);
  assert.equal(readTurnState(P.get("agy")!, { kind: "agy", startedAt: 0 }, "/x", home), null);
});

// The sqlite branch's existsSync(dbPath) check short-circuits before
// node:sqlite is ever require_'d, so this doesn't exercise the lazy load
// itself (Ruling 1) — it proves the narrower, still-necessary thing: an
// absent database degrades to null exactly like a missing transcript file,
// not a different code path that could throw.
test("opencode: a missing sqlite db degrades to null rather than throwing", () => {
  const home = tmpDir();
  assert.equal(readTurnState(P.get("opencode")!, { kind: "opencode", startedAt: 0 }, "/work/proj", home), null);
});
