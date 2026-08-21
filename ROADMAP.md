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
    versioning for `@jefelabs/herdr-broker-client` and `-ui`.
13. **Federation validation.** Every feature routes through `callInstance`
    so children should work at matching plugin versions, but no end-to-end
    parent↔child pairing test exists yet.
14. **React hooks entry point** for the SDK/ui packages — organisms take
    props today; a hooks layer was explicitly deferred.

## Suggested order

Name (11) → the herdr probe (1–3) whenever a live 0.8.x
is available, since it unblocks the biggest structural items → publication
(12) once the name is settled.
