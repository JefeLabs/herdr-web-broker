/** Per-CLI knowledge neither herdr nor the CLIs expose machine-readably:
 * where a session transcript lives, how to pin its id at launch, what a
 * terminal turn looks like. Same shape as model-registry.ts — builtins in
 * code, [[cli.profiles]] rows in config.toml overriding by kind. A kind
 * whose format is unverified ships with `transcript` ABSENT rather than
 * stubbed; the decision tier reads absence as "fall back to agent_status". */

export type TranscriptSource =
  | { via: "path"; template: string }
  | { via: "map"; mapFile: string; template: string }
  | { via: "sqlite"; dbPath: string; queryBySession: string; queryByCwd: string }
  /** No pinnable id and no cwd->id map: find the file BY the cwd it recorded.
   * `dirTemplate` takes {home} plus {YYYY}/{MM}/{DD}, expanded for today and
   * yesterday — a date-partitioned store keeps the scan to a handful of files
   * instead of the whole history, and a live session is always in one of the
   * two. Only each candidate's FIRST line is read; the per-kind reader that
   * pulls a cwd out of it lives beside that kind's parser. */
  | { via: "scan"; dirTemplate: string; filePrefix: string };

export interface CliProfile {
  kind: string;
  /** launch flag that fixes the session id, when the CLI has one */
  pin?: { flag: string };
  transcript?: TranscriptSource;
  /** per-kind vocabulary read out of the transcript */
  terminal?: { done: string[]; blocked: string[]; running: string[] };
  /** first-run prep: point the CLI at a broker-owned config dir */
  prepare?: { configDirEnv: string; fileName: string; contents: Record<string, unknown> };
  /** how long interactive_ready must HOLD before a spawn is believed */
  settleMs?: number;
  source: "builtin" | "config";
}

export interface CliConfig {
  profiles?: Array<Omit<CliProfile, "source">>;
}

const HOME = "{home}";

const BUILTIN: Array<Omit<CliProfile, "source">> = [
  {
    kind: "claude",
    pin: { flag: "--session-id" },
    // {configDir} is $CLAUDE_CONFIG_DIR when `prepare` (below) redirected
    // it for this spawn, else {home}/.claude — readTurnState resolves
    // which (transcript.ts): CLAUDE_CONFIG_DIR relocates this CLI's WHOLE
    // config dir, projects/ included, so the transcript has to be looked
    // for wherever the CLI actually wrote it, not always under {home}.
    transcript: { via: "path", template: `{configDir}/projects/{cwdSlug}/{sessionId}.jsonl` },
    terminal: {
      done: ["end_turn", "stop_sequence", "max_tokens", "refusal"],
      blocked: ["tool_use"],
      running: [],
    },
    prepare: {
      configDirEnv: "CLAUDE_CONFIG_DIR",
      fileName: ".claude.json",
      contents: { hasTrustDialogAccepted: true, hasCompletedOnboarding: true },
    },
    settleMs: 2500,
  },
  {
    kind: "agy",
    // --conversation RESUMES an existing id; minting a fresh one is
    // unverified (wire test WT-2). Until then agy is discovered through
    // its own cwd -> conversation-id cache map.
    transcript: {
      via: "map",
      mapFile: `${HOME}/.gemini/antigravity-cli/cache/last_conversations.json`,
      template: `${HOME}/.gemini/antigravity-cli/brain/{sessionId}/.system_generated/logs/transcript.jsonl`,
    },
    terminal: { done: ["PLANNER_RESPONSE"], blocked: ["ASK_QUESTION"], running: ["RUNNING"] },
    settleMs: 2500,
  },
  {
    kind: "opencode",
    pin: { flag: "--session" },
    // Probed 2026-08-27. `opencode export` also works but spawns a
    // subprocess emitting ~561KB per call — unusable on a 500ms poll.
    // The db's `session.directory` column IS the cwd, so discovery for an
    // unpinned session is a SQL predicate, not a heuristic.
    transcript: {
      via: "sqlite",
      dbPath: `${HOME}/.local/share/opencode/opencode.db`,
      queryBySession:
        "SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1",
      queryByCwd:
        "SELECT m.data AS data FROM message m JOIN session s ON s.id = m.session_id" +
        " WHERE s.directory = ? ORDER BY m.time_created DESC LIMIT 1",
    },
    // Completion is STRUCTURAL for opencode — the presence of
    // time.completed, not a vocabulary word — so `done` names the ROLES
    // whose completed rows settle a turn. It previously read
    // `done: ["completed"]`, which named the FIELD and looked like live
    // config while parseOpencode ignored the block entirely (roadmap 25(e)).
    // `blocked` is deliberately empty: opencode's `permission` table is a
    // project-scoped grant ledger, not a pending-approval queue, so blocked
    // continues to come from agent_status; `running` has no vocabulary here
    // either, since anything not done is working.
    terminal: { done: ["assistant"], blocked: [], running: [] },
    settleMs: 2500,
  },
  {
    kind: "codex",
    settleMs: 2500,
    // No launch pin: `codex resume [ID]` resumes, it does not mint, so
    // discovery runs cwd -> file. WT-4 (live, 2026-08-29, codex-cli 0.151.0)
    // confirmed a rollout records its own cwd in `session_meta.payload.cwd`.
    //
    // `scan` rather than `path` because there is no id to template with, and
    // the directory is DATE-partitioned, which is what makes the scan cheap:
    // ~/.codex/sessions holds 25.9k files / 510MB on a working machine, so a
    // recursive walk costs ~210ms — untenable on a 500ms ask poll — while
    // today's directory holds a handful and costs ~1ms.
    transcript: {
      via: "scan",
      dirTemplate: `${HOME}/.codex/sessions/{YYYY}/{MM}/{DD}`,
      filePrefix: "rollout-",
    },
    // payload.type on event_msg rows. `blocked` is empty: no approval event
    // was observed in WT-4's run, so that axis stays with agent_status.
    terminal: { done: ["task_complete"], blocked: [], running: ["task_started"] },
  },
  // copilot: spawnable, but its store's turn format is unverified (WT-5 ran
  // but could not clear the first-run trust gate). No `transcript` key =
  // status tier.
  { kind: "copilot", settleMs: 2500 },
];

export class CliProfiles {
  #byKind = new Map<string, CliProfile>();

  constructor(cfg?: CliConfig) {
    for (const p of BUILTIN) this.#byKind.set(p.kind, { ...p, source: "builtin" });
    for (const p of cfg?.profiles ?? []) this.#byKind.set(p.kind, { ...p, source: "config" });
  }

  get(kind: string): CliProfile | undefined {
    return this.#byKind.get(kind);
  }

  list(): CliProfile[] {
    return [...this.#byKind.values()];
  }
}
