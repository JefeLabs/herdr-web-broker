# Roadmap

What's deliberately not built yet, and why. Items reference the honest gaps
documented in the README and [docs/agent-lifecycle.md](docs/agent-lifecycle.md).

## Herdr-surface gaps (2026-08-21 schema review) — current priorities

Comparing herdr's full 149-method surface against what the broker
first-classes (everything IS reachable via the /rpc passthrough; these are
missing endpoints/SDK/UI, not missing reachability):

20. ~~**Worktrees.**~~ Done: spawn mode C (`worktree: {branch, base?}` with
    cwd) runs the agent in an isolated checkout; GET
    ./workspaces/{w}/worktrees inventories; DELETE ./worktrees/{w} removes
    the checkout while the BRANCH survives for merging. Wire-verified and
    proven live: two agents on two branches of one repo, one removed, the
    other untouched.
21. ~~**Consumer wait endpoint.**~~ Done: `POST ./agents/{pane}/wait` —
    status wait (`until`, default idle|blocked|done) or output wait
    (`match` + substring|regex); timeout is a branchable 200, not an
    error. Rides agent.wait / pane.wait_for_output.
22. ~~**`agent.explain` debug surface.**~~ Done: `GET
    ./agents/{pane}/explain` + console card — rules, evidence counts,
    region preview. Fixed a latent route bug on the way: the agents-list
    matcher lacked a length check and swallowed agents GET sub-routes.
23. ~~**Event passthrough**~~ Done with item 8: `broker.events.subscribe`
    on `WS /events` streams any of herdr's 27 subscription types
    (parameterized `pane.output_matched` included) as pushed `herdr_event`
    frames — from the runtime AND from enrolled children over new `sub`/
    `unsub` tunnel frames (proto 2). Dead taps and disconnected children
    push `sub_closed` instead of going silent; caps 8 groups/socket, 32
    types/group; SDK `events.subscribe()` auto-re-subscribes after
    reconnect. Proven end to end by the federation probe: a child's
    `workspace_created` crossed child herdr → tunnel → parent → client WS.

## Agent lifecycle determinism (2026-08-27 spec)

24. ~~**Transcript-tier evidence.**~~ Done: for the three CLIs whose
    session-file formats are verified, the broker reads the CLI's OWN
    transcript instead of trusting only herdr's screen-inferred
    `agent_status` — `claude` (`--session-id`-pinned JSONL under
    `~/.claude/projects/`), `agy` (cwd → conversation-id cache map,
    since `--conversation` only RESUMES an existing id — WT-2 asks
    whether it can mint one), and `opencode` (`--session`-pinned,
    `~/.local/share/opencode/opencode.db` SQLite+WAL, a finished turn
    keyed off `time.completed` — WT-3 probed and answered live
    2026-08-27; `opencode export` was rejected as a ~561KB-per-call
    subprocess, unusable on a 500ms poll). `decideTurn` is the pure
    tier: transcript evidence wins only when its record is fresher than
    the current turn's own prompt, so a stale file never masquerades as
    fresh proof. `POST .../agents/{pane}/wait` returns the result as
    `evidence: "transcript" | "status"`, and `ask`'s `agent_unresponsive`
    fast-fail carries the same field in its error details, so a caller
    can tell proof from inference; `GET .../agents` is unchanged and
    stays status-tier only. The practical gain: on the transcript tier a
    dead agent is now distinguishable from an idle one — it stops
    writing and never emits a terminal stop — closing the worst blind
    spot in the `done`/`unknown` → `idle` fold for those three kinds.
    Stayed honest: `codex` and `copilot` remain on the status tier —
    their transcript formats are still unverified (WT-4, WT-5) — and
    even on the transcript tier, WHY an agent died stays unreported
    (WT-6: whether herdr's `pane.exited` carries an exit code is still
    open); a `wait` can also come back with a `status` that doesn't
    satisfy the `until` you asked for, when a transcript record written
    during the wait outvotes the status herdr already resolved against.
    Shipped alongside: a per-CLI profile registry (`cli-profiles.ts`,
    builtins + `[[cli.profiles]]` config.toml overrides — same shape as
    `model-registry.ts`); `POST .../panes/{pane}/exec` runs a command
    and reports its real exit code (a nonzero exit is a 200-shaped
    `ok: false`, only a missing exit code within budget 504s);
    `GET .../sessions/{s}/orphans` reports live workspaces the broker
    never indexed without ever closing them (`classifySession`'s
    adopt/forget/orphans split, reused honestly by session teardown,
    which now also returns an informational `unrecognized` list);
    `prepareWorkspace` pre-answers first-run trust dialogs via a
    broker-owned config dir injected through the environment, so the
    dialog never reaches the screen for kinds with a `prepare` profile
    (`claude` today); and a readiness settle window that treats
    `interactive_ready` as a level to HOLD across ~2.5s rather than an
    edge to catch once, so a CLI that renders and then crashes fails the
    spawn instead of handing back a dead pane id. `node:sqlite` needing
    a flag-free runtime pushed `engines.node` to `>=22.13.0`. A live
    wire-test suite (`test/wire/`, gated on `HERDR_WIRE=1`, excluded
    from `npm test` because the glob only matches `*.test.js`) records
    the two still-open questions: WT-1, whether `pane.send_input`
    brackets multi-line paste (unverified — if it doesn't, every
    multi-line prompt through the broker is quietly submitting early,
    which would be a bug fix, not a config row), and WT-2 above.

25. **Lifecycle-determinism follow-ups.** Deferred from item 24's final
    whole-branch review, ordered by what a maintainer would hit first.
    (a) **Teardown clears one index, not both.** `demolishOwned` now
    removes `AgentIndex` rows but still leaves `WorkspaceIndex` ones,
    while `broker.workspace.close` clears both — the sibling stores are
    inconsistent at that call site. Session names are deterministic, so
    a user who tears down and re-authenticates gets the same name back
    and inherits stale rows; since `resolveCwd` falls back to the index
    when herdr doesn't list a workspace, a stale row can hand a repo
    endpoint a path from a session that no longer exists. Pre-existing,
    but item 24 made it asymmetric. (b) **`ask` and `wait` resolve cwd
    differently.** `resolveCwd` prefers HERDR's cwd and falls back to
    the index; `waitAgent` reads the index directly. For a mode-C
    worktree spawn — where the index deliberately holds the CHECKOUT
    path — the two can disagree, yielding different `cwdSlug` values and
    so different `claude` transcript paths for one pane. It degrades
    safely (wrong slug → no file → status tier), which is why it
    shipped, but the fix needs a shared NON-THROWING resolver: `wait`
    cannot simply adopt `resolveCwd`, which throws `unknown_workspace`
    and would turn a currently-succeeding wait into an error.
    (c) **`GET .../agents` carries no `evidence`.** The spec claimed it
    would; only `wait`'s reply and `ask`'s `agent_unresponsive` details
    do. Wiring it means a transcript read per agent per list call
    against a registry fed by push WS events rather than per-request
    computation — a deliberate design decision, not an oversight.
    (d) **`agy`'s concurrent-same-cwd collision is still open.** The
    `startedAt` bound rejects a transcript older than the agent, so a
    STALE map entry can't be claimed, but two `agy` agents live in one
    cwd still resolve to the same conversation. WT-2 (can
    `--conversation` mint a fresh id?) is what actually closes it.
    (e) **`opencode`'s `terminal.done` is dead config.** `parseOpencode`
    keys off the presence of `time.completed` and never reads its
    `profile`, so a `[[cli.profiles]]` override of that vocabulary
    silently no-ops — unlike `claude`/`agy`, where it takes effect.
    (f) **`transcript.ts` mixes layers.** It holds the pure parsers, the
    pure `decideTurn` tier, AND fs/sqlite I/O, against the spec's "all
    I/O stays in thin shells". A `transcript-resolve.ts` split would
    honor that; not worth churning while the format work is still live.
    (g) **No integration test** covers `GET .../orphans` or teardown's
    `unrecognized` field — `classifySession` is fully unit-tested, the
    HTTP wiring is not.

26. **Publish the SDK — it is not installable.** All three library
    packages (`@jefelabs/herdr-broker-client`, `-react`, `-ui`) sit at
    0.1.0, unpublished, while `herdr-plugin.toml`'s own description
    sells "TypeScript SDK and React packages". Anyone building a client
    today must vendor the source or take a git dependency on an
    unpublished 0.1.0. For a project whose differentiator over
    herdr-remote/mirror/mobile-relay is "an API, not an app", the API's
    client being unreachable is the single largest adoption barrier —
    and unlike the rest of this list it is not a design question, it is
    an unpushed button. Everything needed already exists:
    `.github/workflows/release.yml` publishes all three on a `v*` tag
    with `--access public --provenance`, and its own header documents
    the one-time setup (add an npm automation token as the `NPM_TOKEN`
    secret). Note the workflow covers THREE packages, not the two the
    description advertises — `-ui` ships too. Do this before item 25's
    API-versioning window closes for real: `/v1` aliases are cheap to
    keep while the only caller is this repo, and become a compatibility
    obligation the moment someone installs from the registry.

27. **Spawn readiness — prove the shell is at its prompt, don't guess.**
    Spec: `docs/superpowers/specs/2026-08-28-spawn-readiness-design.md`.
    `spawn()` creates a pane and calls `agent.start` almost immediately;
    on a cold pane whose login shell has not reached its prompt herdr
    refuses with `agent_pane_busy` ("not an available shell"). A field
    report filed this as high severity. Two of its four points are
    already fixed — the internal `4× @ ~1s` retry (`workspace-ops.ts:
    568-569`) and the per-retry workspace leak, which went away when
    mode B moved to `pane.split` — so the race is currently ABSORBED,
    not present: it costs up to ~4s of internal retrying on every cold
    macOS pane rather than surfacing an error. What is left is that the
    broker is paying a timeout instead of asking a question.
    The report's own suggested fix (poll `interactive_ready` before
    `agent.start`) is NOT implementable: that field comes from
    `agent.list`, which lists AGENTS, and before `agent.start` there is
    no agent in the pane. `workspace-ops.ts:564` already records the
    same conclusion — "herdr's refusal is the only verified readiness
    signal". True of what herdr EXPOSES; not of what the broker can
    ELICIT. Proposed instead: a sentinel. Push
    `printf '__herdr_ready_<id>__'` through the PTY and
    `pane.wait_for_output` for it; when it echoes, the shell is provably
    at its prompt and executing commands — shell-agnostic, no
    prompt-pattern matching, and on the env path it appends to the line
    the broker already sends, so one round trip replaces both the 300ms
    sleep and the guess. It also covers mode B, mode C, and mode A
    without env vars, all three of which get ZERO settle today (only
    mode-A-with-env sleeps, and `claude` lands there only incidentally,
    because roadmap 24's `prepare` block gives it a non-empty env map).
    Deliberately NOT the report's `spawn_settle_ms`: a tunable sleep is
    still a guess, just a longer one. The only number that survives is a
    timeout, which bounds failure rather than estimating success, and
    `envSettleMs` — a test-only override wired to no config — is deleted
    rather than promoted.
    **Blocked on WT-7** (`test/wire/shell-ready.wire.ts`, written and
    committed, not yet run — needs a live herdr): does
    `pane.wait_for_output` match the pane's OWN echoed input, or only
    program output? The design is worthless if it is the latter.
    Inference from the API's shape, not a probe: it takes
    `source: "visible" | "recent"`, the same vocabulary `pane.read`
    takes, and a matcher tapping program output would have no use for a
    screen/scrollback distinction — so it very likely matches the
    rendered buffer. Do not build the rest until WT-7 is green; if it is
    red, keep the retry as the sole mechanism, which is what ships
    today anyway. Note this also means the existing readiness settle
    window from roadmap 24 does not help here: it samples
    `interactive_ready` AFTER `agent.start`, to catch a CLI that renders
    then dies. Two windows, and the shipped one sits on the far side of
    this failure.

28. **Module system — capabilities, not internals.** Spec:
    `docs/superpowers/specs/2026-08-28-extension-model-design.md`.
    Operators need to add their own git, file and workspace
    functionality. Today the only extension points are data rows in
    config.toml and the `/rpc` passthrough, which reaches herdr but adds
    no broker-side shaping — neither can add an endpoint.
    An earlier draft argued config-declared endpoints are unsafe because
    `git-exec.ts`'s guarantees (execFile NEVER a shell, hard timeout,
    preview-then-confirm with a hash bound to HEAD AND the exact file
    set) cannot be expressed in TOML. True, and the wrong lesson: a
    module is not TOML, it is CODE, and code can call those helpers
    directly instead of reimplementing them. So safety does not live in a
    schema constraining what an operator may declare — it lives in WHAT
    THE BROKER HANDS THE MODULE. The module API is a capability surface,
    not a pointer to internals; everything else follows from that.
    Hand a module `api.git.raw(ws, repo, argv[])` and it inherits the
    no-shell execution, the timeout and the repo-path guard for free;
    hand it `OpsDeps` and it inherits nothing and every author re-derives
    the security model badly. `api.files` resolves through the same
    realpathSync escape guard askInner and execCommand use, so a module
    physically cannot write outside its workspace even via a committed
    symlink. `raw` takes an argv ARRAY and rejects a string — no shell to
    inject into — with an allowlist denying `reset --hard`, `clean -fd`,
    `push --force`; those must go through the vetted verbs that audit and
    confirm. Routes mount under `/v1/modules/{id}/...` so core collision
    is impossible and a URL says which tier it is; the broker
    authenticates BEFORE dispatch, so a module cannot opt out of auth or
    see the token.
    Three deliberate exclusions, each for a reason: spawning agents (the
    spawn path owns env injection, session-id pinning, prepareWorkspace
    and the readiness gate — a module reaching around it produces agents
    the broker cannot track), creating/closing workspaces (those carry
    item 24-25's reaping and orphan-reporting semantics), and installing
    a module over the API — CONFIG-ONLY, because a module is in-process
    code and a bearer token that could install one would be a remote
    shell. Modules are NOT sandboxed: daemon process, daemon privileges,
    nothing stops one importing node:fs directly. Installing a module is
    installing code, same trust as an npm dependency; the capability
    surface makes the safe path the easy path, it is not a security
    boundary against a hostile module, and the docs must say so without
    hedging. The ABI is the real cost — once a third party ships against
    `abi: 1` it is a compatibility obligation forever, which argues for
    keeping the v1 surface small. Load failures degrade (that module's
    routes 404, the broker still boots) rather than taking the whole API
    down for one optional extension. Open in the spec: `.js`-only vs a TS
    loader; whether `api.git.raw` is too sharp (enumerating safe
    subcommands is safer and guarantees this does not meet the stated
    need); and whether module-emitted events turn the ABI into a message
    bus. Coupled to item 26 — the ABI wants to ship as a published
    `packages/module` alongside the SDK, not after it.

## Blocked on herdr (needs a live schema probe)

The 2026-08-21 schema probe against live herdr (protocol 19, via the demo
container) wire-verified `workspace.close`, `pane.split` (with a native env
map!), `pane.close`, `agent.wait`, and `agent.prompt`'s
`wait:{until,timeout_ms}` — all three items are unblocked:

1. ~~**Workspace reaping.**~~ Done: `DELETE .../workspaces/{w}` closes the
   workspace (herdr `workspace.close`); mode-B spawns now `pane.split` INTO
   the existing workspace with herdr-native env injection — the leak is
   gone at the source.
2. ~~**Agent stop/restart endpoint.**~~ Done: `DELETE .../agents/{pane}`
   closes the agent's pane (herdr `pane.close`); requires an agent in the
   pane so a typo cannot close someone's shell. Restart = stop + mode-B
   spawn into the same workspace.
3. ~~**`ask()` via `agent.wait`.**~~ Closed as already-achieved: inspection
   showed ask() samples in-memory registry state (fed by the WS status
   subscription — push, not poll) plus a local-disk file check — zero herdr
   round-trips per iteration. Wiring `agent.wait` would ADD a held-open
   connection per ask to replace a free memory read, and cannot speed up
   the answer file itself. The probe's semantics (`wait` = transition INTO
   a target status; `pane.wait_for_output {match}`) are recorded for
   future use.

## Product features, deferred deliberately

4. ~~**Git: `pull`, `discard`/`restore`, `stash`.**~~ Done — the two
   parked questions got answers: pull conflicts AUTO-ABORT and report
   files (no half-merged repo ever survives an API call; resolving is
   agent work), and discard is preview-then-confirm with a stateless
   hash bound to HEAD + the exact file set (a changed tree answers 409
   stale_confirm; executed discards are audited). Stash push/list/pop
   completes the set-aside loop — a conflicted pop undoes itself via
   `git reset --merge` and the stash survives. SDK RepoHandle verbs +
   five console cards ride along.
5. ~~**Agent ownership.**~~ Done as SESSION ownership (spec 2026-08-22):
   one email owns one herdr session — auto-provisioned on `/auth`
   (`herdr server --session u-…`, sticky binding, 409 for another token),
   hard isolation (owned sessions are 404-invisible to other bearers, no
   oracle; unowned stay shared), detach vs teardown semantics
   (kick/disconnect leave the herdr working; `DELETE .../sessions/{s}`
   demolishes it), admin surface (list/rebind/kill — kill also
   invalidates the token), and the INVARIANT that the primary herdr
   hosting this plugin can never be stopped. Proven live in Docker: a
   real `/auth` provisioned a real second herdr and teardown left the
   primary serving.
6. ~~**Token minting endpoint**~~ Done: `POST /admin/tokens`, dev-gated via
   `[token_mint] enabled = true` (off by default; the demo stack enables it).
7. ~~**Context: inject file contents.**~~ Done: per-attachment `inline`
   flag (upload `?inline=1` or POST `{inline}`) embeds small TEXT files
   whole into prompt preambles — 12KB/file, 20KB total; binary/oversized
   files fall back to the path listing with honest annotations, never
   truncated. PDF text extraction deliberately deferred (needs a parser
   dependency in the zero-dep broker).
8. ~~**Push-based streaming.**~~ Done with item 23 (see its entry for the
   full shape): subscription vocabulary over `WS /events`, dedicated
   herdr tap per group, and `sub`/`unsub` tunnel frames so children's
   events push through the parent. Bundles/files still long-poll by
   design — push is for events, polls stay for content.

## Known rough edges (small fixes)

9. ~~**EventChannel reconnect after kick.**~~ Done: a pre-reconnect auth
   probe detects 401, stops the loop, and emits `auth_failed`.
10. ~~**OpenAPI response schemas.**~~ Done: all 38 operations declare
    success schemas (responses.ts), enforced by a completeness test.

## Field-found gaps (2026-08-20 review)

15. ~~**Per-pane conversation safety.**~~ Done: ask serializes per pane
    (second concurrent ask answers 409 `pane_busy`, lock releases on
    failure); steering during an ask stays allowed — that is a feature.
16. ~~**Security tier for shared instances.**~~ Done: client tokens hashed at
    rest (auto-migrated on boot, mint is show-once), per-address failed-auth
    rate limiting (credential-less requests never count), and an append-only
    audit trail (admin ops + env writes) readable via GET /admin/audit.
17. ~~**Live pane viewer.**~~ Done: `GET .../panes/{pane}/screen` long-polls
    by content version; SDK `watchScreen()`/`type()`/`keys()`; PaneViewer
    organism + demo Pane page (interactive — trust dialogs answered live).
18. ~~**Codify manual verification into CI.**~~ Done: 12-test Playwright e2e
    suite (gate/console/pane/kick vs the devstack) in ci.yml on every push/PR,
    plus a weekly real-herdr wire probe (herdr-drift.yml) that auto-files a
    `herdr-drift` issue on failure.
19. ~~**Demo Copilot auth passthrough.**~~ Done: `docker run -e
    COPILOT_GITHUB_TOKEN=...` seeds the env registry (kind `copilot`) at
    boot; spawn injection carries it into the CLI process (verified via
    /proc environ). All five field-found gaps are now closed.

## Release & ecosystem

11. ~~**The name.**~~ Decided 2026-08-22: **`herdr-web-broker` stands.**
    The call was made against the actual marketplace shelf (the
    `herdr-plugin` GitHub topic self-indexes it): the remote-access
    cluster reads as consumer apps (`herdr-remote`, `herdr-mobile-relay`,
    dashboards), so an infrastructure-sounding name IS the positioning;
    "broker" is accurate to the trust role (tokens, audit, federation,
    and now brokering users onto owned herdrs); nobody else uses it; the
    npm family (`@jefelabs/herdr-broker-*`) already coheres; zero rename
    churn. Runner-up `herdr-gateway` (parses faster for API-infra folks)
    recorded here in case publication feedback ever reopens it — the
    cost only rises from now on.
12. ~~**Publication.**~~ Done up to the release act itself (2026-08-22):
    the marketplace listing is LIVE (the `herdr-plugin` topic self-indexes
    it; manifest declares `platforms = ["macos", "linux"]` — warning
    wire-verified gone — and the repo description/homepage are set for the
    shelf). npm readiness: all three packages carry full metadata, MIT
    LICENSE, pinned internal deps (`^0.1.0`), and `-client` ships the
    planned subpath exports (`/events` resolves live; `/types` serves
    pure type declarations) — pack dry-runs are lean (8–17kB). Releasing
    is two acts only the maintainer can do: add the `NPM_TOKEN` secret,
    then `git tag v0.1.0 && git push --tags` — release.yml runs every
    suite and publishes client → react → ui with npm provenance. The
    headless/skin split is done: `-react` carries every behavior hook
    (zero markup) and `-ui` is the default plain-CSS skin over it —
    design-system skins (`-ui-heroui`, `-ui-bootstrap` as npm packages;
    a shadcn flavor ships as a copy-in registry, that ecosystem's
    distribution model) depend on `-react` alone and arrive as demand
    shows up. Framework adapters (`-svelte`, `-vue`) follow the same
    rule: never a hand-port of the hooks — first extract the
    framework-free behavior cores (log models, subscription parsing,
    mint/browse flows) down into `-client`, then ship thin adapters over
    them, so frameworks can never drift apart.
13. ~~**Federation validation.**~~ Done: `scripts/federation-test.sh` boots
    two real containers (parent + child dialing out over a docker network)
    and drives the child entirely through the parent — enrollment, herdr
    passthrough, spawn/mode-B/screen-long-poll/env/stop/close over the
    tunnel, the remote deny-list, and offline detection (13 checks). Runs
    weekly in herdr-drift.yml and on demand locally. Wire truth captured:
    herdr reaps a workspace when its last pane closes.
14. ~~**React hooks entry point.**~~ Done: `BrokerProvider`/`useBroker`,
    `useVerify`, `useScreen`, `useAgents`, `useWorkspaces`,
    `useEventChannel` — each extracted from the organisms' proven effects
    and consumed BY the organisms (dogfooded), so hook and component never
    drift. All existing ui/demo/e2e suites passed unchanged through the
    refactor.

## Suggested order

The numbered roadmap is COMPLETE — 24 of 24, item 24 (agent lifecycle
determinism) landing after publication. What remains is the maintainer's
release act (NPM_TOKEN secret + v0.1.0 tag), the two open wire-truth
questions item 24 recorded (WT-1 paste bracketing, WT-2 agy id minting —
`test/wire/`) plus the still-pending `codex`/`copilot` transcript formats
(WT-4, WT-5) and herdr's `pane.exited` exit code (WT-6), and the
demand-driven tails recorded in the strike notes (skins, framework
adapters, federated multi-user, PDF extraction, quotas) plus the
in-flight model-discovery spikes. In flight, pending credentialed spikes: per-user
model discovery (probe-on-spawn keyed by credential context, `auto`
until a list is recorded — ACP body vs pane body undecided until the
wire truth lands).
