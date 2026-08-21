# Roadmap

What's deliberately not built yet, and why. Items reference the honest gaps
documented in the README and [docs/agent-lifecycle.md](docs/agent-lifecycle.md).

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

4. **Git: `pull`, `discard`/`restore`, `stash`.** Pull needs a
   merge-conflict UX design; discard is destructive and needs a
   confirmation model. Scoped out of the vibe-coding v1 on purpose.
5. **Agent ownership.** Kick logs out ALL matching-kind agents because
   agents aren't tagged by the token that spawned them. Multi-user
   isolation needs that ownership model.
6. ~~**Token minting endpoint**~~ Done: `POST /admin/tokens`, dev-gated via
   `[token_mint] enabled = true` (off by default; the demo stack enables it).
7. **Context: inject file contents.** Prompts list attachment PATHS; an
   option to inline small text files (or extract PDF text) is parked.
8. **Push-based streaming.** Bundles/files long-poll by design (rides the
   parent↔child tunnel unchanged); true SSE/WS push needs new tunnel
   plumbing.

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
    versioning for `@jefelabs/herdr-broker-client` and `-ui`. Packaging
    plan: events + models already live in `-client` — expose them as
    subpath exports (`/events`, `/types`) rather than a third `-sdk`
    package; revisit the split only if a consumer needs the wire types
    without the client (e.g. a server-side schema sharer).
13. ~~**Federation validation.**~~ Done: `scripts/federation-test.sh` boots
    two real containers (parent + child dialing out over a docker network)
    and drives the child entirely through the parent — enrollment, herdr
    passthrough, spawn/mode-B/screen-long-poll/env/stop/close over the
    tunnel, the remote deny-list, and offline detection (13 checks). Runs
    weekly in herdr-drift.yml and on demand locally. Wire truth captured:
    herdr reaps a workspace when its last pane closes.
14. **React hooks entry point** for the SDK/ui packages — organisms take
    props today; a hooks layer was explicitly deferred.

## Suggested order

Remaining build work first — federation validation (13) as the only
untested structural claim, agent ownership (5) as the strongest feature
candidate, then the rest of the deferred features (4, 7, 8) and the hooks
layer (14) as demand dictates. The **name (11) comes second to last** and
**publication (12) last** — renaming is cheap until something is
published, so the decision waits until the code is done moving.
