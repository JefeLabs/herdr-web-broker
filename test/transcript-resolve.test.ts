import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CliProfiles } from "../src/cli-profiles.js";
import { readTurnState, claudeCwdSlug } from "../src/transcript.js";
import { prepareWorkspace } from "../src/prepare-workspace.js";
import { tmpDir } from "./util.js";

const P = new CliProfiles();
const DONE_LINE =
  '{"type":"assistant","timestamp":"2026-08-27T10:00:09.000Z","message":{"role":"assistant","stop_reason":"end_turn"}}';
const BLOCKED_LINE =
  '{"type":"assistant","timestamp":"2026-08-27T09:00:00.000Z","message":{"role":"assistant","stop_reason":"tool_use"}}';

test("claude: a pinned session id resolves to a templated path and parses", () => {
  const home = tmpDir();
  const cwd = "/work/proj";
  const dir = join(home, ".claude", "projects", claudeCwdSlug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sid-1.jsonl"), DONE_LINE + "\n");

  const s = readTurnState(P.get("claude")!, { sessionId: "sid-1", kind: "claude", startedAt: 0 }, cwd, home);
  assert.equal(s?.state, "done");
});

// CLAUDE_CONFIG_DIR (prepareWorkspace, Task 6) relocates Claude Code's
// WHOLE config dir, projects/ (transcripts) included — not just the
// trust-dialog file. A broker-made `claude` spawn never writes its
// transcript under {home}/.claude at all; if readTurnState kept looking
// there, this tier would silently see nothing and every claude turn would
// fall back to screen inference, exactly what this branch exists to
// replace. Proven by writing DIFFERENT states at each location: only
// resolving under the prepared dir can produce "done" here.
test("claude: with a prepared config dir, the transcript resolves under it — not under {home}", () => {
  const home = tmpDir();
  const stateDir = tmpDir();
  const cwd = "/work/proj";
  const profile = P.get("claude")!;

  const configDir = prepareWorkspace(profile, stateDir).CLAUDE_CONFIG_DIR!;
  const preparedDir = join(configDir, "projects", claudeCwdSlug(cwd));
  mkdirSync(preparedDir, { recursive: true });
  writeFileSync(join(preparedDir, "sid-2.jsonl"), DONE_LINE + "\n");

  // Decoy at the OLD, unprepared $HOME location — a dangling tool_use
  // (blocked), the opposite of the prepared dir's "done".
  const decoyDir = join(home, ".claude", "projects", claudeCwdSlug(cwd));
  mkdirSync(decoyDir, { recursive: true });
  writeFileSync(join(decoyDir, "sid-2.jsonl"), BLOCKED_LINE + "\n");

  const s = readTurnState(profile, { sessionId: "sid-2", kind: "claude", startedAt: 0 }, cwd, home, stateDir);
  assert.equal(s?.state, "done", "resolved from the prepared dir, not the decoy at $HOME");
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

// The cwd->id cache map is last-write-wins (agy has no per-spawn minting
// yet — see cli-profiles.ts's comment on the agy profile). A map entry
// whose own transcript record predates THIS agent's spawn is stale
// evidence left behind by whatever last ran in this cwd, not this
// agent's turn — readTurnState must not hand it back as if it were.
test("agy: a map entry whose transcript predates this agent's own startedAt is stale, not this agent's turn", () => {
  const home = tmpDir();
  const cwd = "/work/proj";
  mkdirSync(join(home, ".gemini", "antigravity-cli", "cache"), { recursive: true });
  writeFileSync(
    join(home, ".gemini", "antigravity-cli", "cache", "last_conversations.json"),
    JSON.stringify({ [cwd]: "conv-stale" }),
  );
  const logs = join(home, ".gemini", "antigravity-cli", "brain", "conv-stale", ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const recordAt = Date.parse("2026-08-27T10:00:06Z");
  writeFileSync(
    join(logs, "transcript.jsonl"),
    '{"step_index":1,"source":"MODEL","type":"ASK_QUESTION","status":"DONE","created_at":"2026-08-27T10:00:06Z"}\n',
  );

  // this agent's own spawn happened a minute AFTER that record — the map
  // entry is a leftover, not this agent's own conversation.
  const s = readTurnState(P.get("agy")!, { kind: "agy", startedAt: recordAt + 60_000 }, cwd, home);
  assert.equal(s, null);
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
