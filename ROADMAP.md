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
