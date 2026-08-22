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

11. **The name.** `herdr-web-broker` vs `herdr-agent-api` /
    `herdr-workbench` — undecided, and the rename cost rises the moment
    anything is published (plugin ids bake into users' herdr config paths).
    Decide before item 12.
12. **Publication.** Marketplace listing for the plugin; npm publishing +
    versioning for `@jefelabs/herdr-broker-client`, `-react`, and `-ui`.
    Packaging plan: events + models already live in `-client` — expose
    them as subpath exports (`/events`, `/types`) rather than a separate
    `-sdk` package; revisit the split only if a consumer needs the wire
    types without the client (e.g. a server-side schema sharer). The
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

Two items remain: the **name (11)** then **publication (12)** —
renaming is cheap until something is published, so the decision waits
until the code is done moving. In flight, pending credentialed spikes: per-user
model discovery (probe-on-spawn keyed by credential context, `auto`
until a list is recorded — ACP body vs pane body undecided until the
wire truth lands).
