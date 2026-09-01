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
  /** how this CLI reattaches an existing conversation (roadmap 31, spawn
   * mode D). `style` is not cosmetic — the shapes genuinely differ across
   * CLIs (`--resume <id>`, `--resume=<id>`, `resume <id>` as a SUBCOMMAND),
   * which is why the flag is stored rather than assumed, exactly as `pin`
   * does. `extraArgs` carries whatever else that CLI needs alongside it.
   *
   * Same rule as `transcript`: a kind whose resume is unverified ships with
   * this ABSENT rather than guessed, and spawn refuses to resume it rather
   * than sending a flag nobody has watched work. WT-2 is why — `agy`
   * ACCEPTS `--conversation <uuid>` and honors nothing. */
  resume?: { flag: string; style?: "arg" | "equals" | "subcommand"; extraArgs?: string[] };
  transcript?: TranscriptSource;
  /** per-kind vocabulary read out of the transcript */
  terminal?: { done: string[]; blocked: string[]; running: string[] };
  /** first-run prep: point the CLI at a broker-owned config dir.
   * `contents` merges at the TOP level of the config file; `perProject`
   * merges under `projects[<cwd>]`, which is where Claude Code actually
   * records directory trust — verified 2026-08-30 against 2.1.251 on
   * WT-11's first run: a top-level `hasTrustDialogAccepted` is written,
   * the CLI reads the broker-owned dir (it wrote its own machineID and
   * migration flags there), and the trust dialog appears anyway. */
  prepare?: {
    configDirEnv: string;
    fileName: string;
    contents: Record<string, unknown>;
    perProject?: Record<string, unknown>;
    /** Trust expressed as a FLAT LIST of paths rather than a map keyed by
     * path — copilot's `trustedFolders`, which its own check reads as
     * `trustedFolders.some(f => repoPathsEqual(f, cwd))`. The same idea as
     * `perProject` in the other shape a real CLI uses; a kind declares
     * whichever its config actually has. */
    trustedPaths?: { key: string };
    /** JSON state files inside the config dir reset to `{}` before EVERY
     * spawn — copilot's `open-sessions-state.json`.
     *
     * This states an intent rather than papering over a UI: a spawn creates a
     * NEW agent, so a CLI that offers to restore somebody's interrupted
     * session on startup must be told not to. Restoring is never what
     * `POST .../agents` means, and a reattach would be an explicit verb
     * (mode D) rather than a startup prompt.
     *
     * Per-kind and opt-in, never blanket: resetting files in a config dir the
     * broker did not fully understand is how CLI state gets destroyed
     * silently (WT-11). */
    resetJson?: string[];
  };
  /** Screen markers proving the CLI started but cannot work — roadmap 33.
   *
   * Present ONLY for a kind whose banner someone has actually watched. Every
   * other kind is absent and never probed, the same discipline `prepare`
   * follows for CLIs whose config format is unverified: a guessed marker that
   * false-matches fails a working spawn, which is worse than not looking.
   *
   * Matched against the VISIBLE pane right after the settle window. Any hit
   * fails the spawn. */
  unauthenticated?: { match: string[] };
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
    // WT-11, live 2026-08-30 (2.1.251). --fork-session is REQUIRED, not
    // optional decoration: --resume alongside the --session-id that `pin`
    // appends is rejected outright ("--session-id can only be used with
    // --continue or --resume if --fork-session is also specified"), and the
    // CLI exits while agent.start still reports success. Forking is also the
    // better half of that trade — the fork lands under the id the BROKER
    // minted, so AgentMeta.sessionId keeps pointing at the live record and
    // the launch-time-known path `pin` exists for survives a resume.
    resume: { flag: "--resume", extraArgs: ["--fork-session"] },
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
      contents: { hasCompletedOnboarding: true },
      // hasTrustDialogAccepted moved OUT of `contents` deliberately. It sat
      // at the top level from the start and never answered anything: trust
      // is keyed by path, and a real ~/.claude.json carries no top-level
      // copy at all. Leaving it would be config that reads live and is not
      // — the trap 25(e) closed for opencode's terminal.done.
      perProject: { hasTrustDialogAccepted: true },
    },
    // WT-13, observed live 2026-08-31 (2.1.252): the redirect above relocates
    // the CLI's whole config tree, credentials included, so a broker-spawned
    // claude sits at this banner while agent.list calls it detected and idle.
    // The wording is "Not logged in · Run /login" — NOT "Please run /login",
    // which is what the roadmap prose said and what a matcher written from
    // that prose would have failed to match, silently and forever.
    // Only the unambiguous half is matched: a bare "/login" appears in help
    // text and in anything a user types, and a false positive here fails a
    // spawn that would have worked.
    unauthenticated: { match: ["Not logged in"] },
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
        // IN (?, ?) — the literal cwd and its realpath. opencode has not been
        // observed storing a resolved path the way copilot does, but the
        // reader passes both forms for every sqlite kind and a one-parameter
        // statement would then throw. Taking both is also simply correct: if
        // opencode ever records a resolved path, this already handles it.
        " WHERE s.directory IN (?, ?) ORDER BY m.time_created DESC LIMIT 1",
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
  {
    kind: "copilot",
    // Measured 2026-09-01 (copilot 1.0.81/1.0.82). Every spawn into a fresh
    // cwd stopped at "Confirm folder trust" and sat there — herdr reported
    // `agent_status: "blocked"`, which is honest and which nothing acted on.
    // copilot had no prepare block because its config format was unverified.
    // It is verified now: `~/.copilot/config.json`, JSONC, with trust as a
    // flat `trustedFolders` array.
    //
    // COPILOT_HOME relocates the whole config dir (a redirected one received
    // config.json, logs/ and session-store.db), and — the difference from
    // claude that makes this free — copilot stays LOGGED IN through the
    // redirect. No credential question stands in front of containment here,
    // unlike CLAUDE_CONFIG_DIR (roadmap 33).
    //
    // `contents` is empty deliberately: a redirected copilot needed no
    // onboarding flag, and trust was the only gate observed. Writing a
    // speculative one would be config that reads live and is not.
    // WT-5, answered 2026-09-01 (copilot 1.0.82). `sessions(id, cwd)` makes
    // cwd -> session_id a SQL predicate, and a completed turn fills
    // `assistant_response`, which is the completion signal that was
    // unconfirmed until an authenticated run finally produced one.
    //
    // json_object() builds the reader's `{data: string}` contract in SQL, so
    // the sqlite source needs no new shape for a second kind.
    //
    // {configDir} because prepare redirects COPILOT_HOME — the store moves
    // with the config dir, so a reader looking in ~/.copilot would query the
    // USER's sessions and never see a broker-spawned one.
    //
    // copilot records `sessions.cwd` as the REALPATH — a /var/... spawn is
    // filed under /private/var/... — while the broker holds whatever cwd it
    // was given. Closed 2026-09-01: queryByCwd takes `IN (?, ?)` and the
    // reader passes the literal form AND the resolved one. Both, not just the
    // resolved one: a CLI that files a session under the unresolved path it
    // was handed would be missed by a realpath-only lookup, which is the same
    // bug pointed the other way (and a mutation proved no test caught it).
    transcript: {
      via: "sqlite",
      dbPath: "{configDir}/session-store.db",
      queryBySession:
        "SELECT json_object('assistant_response', assistant_response, 'timestamp', timestamp) AS data" +
        " FROM turns WHERE session_id = ? ORDER BY turn_index DESC LIMIT 1",
      queryByCwd:
        "SELECT json_object('assistant_response', t.assistant_response, 'timestamp', t.timestamp) AS data" +
        " FROM turns t JOIN sessions s ON s.id = t.session_id" +
        " WHERE s.cwd IN (?, ?) ORDER BY t.timestamp DESC LIMIT 1",
    },
    prepare: {
      configDirEnv: "COPILOT_HOME",
      fileName: "config.json",
      contents: {},
      trustedPaths: { key: "trustedFolders" },
      // The SECOND gate, found 2026-09-01 once the trust one was gone. A
      // broker-owned COPILOT_HOME starts empty, so the first spawn is clean
      // and the original verification of the trust fix could not see this;
      // closing a workspace leaves copilot's session Interrupted, and from
      // the second spawn on it opens on "Choose which sessions to restore"
      // instead of a prompt. Measured both ways: 1 entry -> picker, no
      // prompt; register cleared -> no picker, at the prompt.
      resetJson: ["open-sessions-state.json"],
    },
    settleMs: 2500,
  },
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
