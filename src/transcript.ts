import type { CliProfile } from "./cli-profiles.js";

/** What a CLI's own session file says about the current turn. `done` is a
 * terminal stop the agent WROTE — the ground truth herdr's screen-inference
 * can only approximate. */
export interface TranscriptState {
  state: "working" | "blocked" | "done";
  /** ms since epoch: the timestamp of the record that ESTABLISHED `state`,
   * not necessarily the transcript's newest row. A row appended after the
   * state-determining one (a fresh prompt landing, say) must not make a
   * stale state look freshly re-confirmed — decideTurn's freshness test is
   * `lastRecordAt >= promptedAt`. */
  lastRecordAt: number;
}

/** Claude Code slugs a cwd into its projects dir by replacing both path
 * separators and dots with dashes — verified live: /a/.claude-worktrees/b
 * becomes -a--claude-worktrees-b (the `/.` collapses to `--`). */
export function claudeCwdSlug(cwd: string): string {
  return cwd.replaceAll("/", "-").replaceAll(".", "-");
}

function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as unknown;
      if (o && typeof o === "object") out.push(o as Record<string, unknown>);
    } catch {
      // A partially-flushed final line is normal on a live file — skip it.
    }
  }
  return out;
}

function ts(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Date.parse(v);
  return Number.isNaN(n) ? undefined : n;
}

function parseClaude(text: string, profile: CliProfile): TranscriptState | null {
  const rows = jsonLines(text);
  if (rows.length === 0) return null;
  const done = new Set(profile.terminal?.done ?? []);
  const blocked = new Set(profile.terminal?.blocked ?? []);

  // Walk backwards to the newest assistant message carrying a stop_reason.
  // lastRecordAt is pinned to THAT row's own timestamp, not the file's
  // newest row overall — a prompt appended after a terminal `done` row
  // must read as stale, not as fresh confirmation of a turn that hasn't
  // started (see the TranscriptState.lastRecordAt doc comment).
  for (let i = rows.length - 1; i >= 0; i--) {
    const msg = rows[i].message as { stop_reason?: unknown } | undefined;
    const reason = typeof msg?.stop_reason === "string" ? msg.stop_reason : undefined;
    if (!reason) continue;
    const at = ts(rows[i].timestamp);
    if (at === undefined) return null;
    if (done.has(reason)) return { state: "done", lastRecordAt: at };
    if (blocked.has(reason)) {
      // A tool_use answered by a later tool_result means the turn is still
      // moving; an unanswered one means the agent is waiting on approval.
      const answered = rows.slice(i + 1).some((r) => r.toolUseResult !== undefined);
      return { state: answered ? "working" : "blocked", lastRecordAt: at };
    }
    return { state: "working", lastRecordAt: at };
  }

  // No row carries a stop_reason at all — e.g. only a user turn has landed
  // so far. There's no state-determining row to pin to, so fall back to
  // the newest timestamp in the file: the best available evidence of when
  // the transcript was last touched, for a state ("working") that isn't
  // claiming to be terminal anyway.
  let lastRecordAt = 0;
  for (const r of rows) lastRecordAt = Math.max(lastRecordAt, ts(r.timestamp) ?? 0);
  if (lastRecordAt === 0) return null;
  return { state: "working", lastRecordAt };
}

function parseAgy(text: string, profile: CliProfile): TranscriptState | null {
  const rows = jsonLines(text);
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const lastRecordAt = ts(last.created_at);
  if (lastRecordAt === undefined) return null;

  const running = new Set(profile.terminal?.running ?? []);
  const blocked = new Set(profile.terminal?.blocked ?? []);
  const done = new Set(profile.terminal?.done ?? []);
  const status = String(last.status ?? "");
  const type = String(last.type ?? "");

  // status is an explicit liveness field — RUNNING beats every type check.
  if (running.has(status)) return { state: "working", lastRecordAt };
  if (blocked.has(type)) return { state: "blocked", lastRecordAt };
  if (done.has(type) && status === "DONE") return { state: "done", lastRecordAt };
  return { state: "working", lastRecordAt };
}

/** Opencode's row `data` is a small JSON blob: {role, time, agent, model}.
 * A finished assistant turn carries time.completed (verified: 116/116
 * completed assistant messages had it); anything else is still in flight —
 * a `user` row means the prompt landed and no reply exists yet, an
 * `assistant` row without `completed` is mid-generation.
 *
 * Never returns "blocked": opencode has no live pending-approval store, so
 * that axis stays with agent_status. decideTurn needs no special case for
 * this — a state this parser never emits is a state it never overrides. */
function parseOpencode(text: string): TranscriptState | null {
  const d = JSON.parse(text) as { role?: string; time?: { created?: number; completed?: number } };
  const created = typeof d.time?.created === "number" ? d.time.created : undefined;
  const completed = typeof d.time?.completed === "number" ? d.time.completed : undefined;
  const lastRecordAt = completed ?? created;
  if (lastRecordAt === undefined) return null;
  if (d.role === "assistant" && completed !== undefined) return { state: "done", lastRecordAt };
  return { state: "working", lastRecordAt };
}

const PARSERS: Record<string, (t: string, p: CliProfile) => TranscriptState | null> = {
  claude: parseClaude,
  agy: parseAgy,
  opencode: parseOpencode,
};

/** Never throws: an unparseable transcript is `null`, and every caller
 * treats null as "no transcript evidence" and falls back to agent_status. */
export function parseTranscript(kind: string, text: string, profile: CliProfile): TranscriptState | null {
  try {
    return PARSERS[kind]?.(text, profile) ?? null;
  } catch {
    return null;
  }
}
