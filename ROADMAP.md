# Roadmap

What's deliberately not built yet, and why. Items reference the honest gaps
documented in the README and [docs/agent-lifecycle.md](docs/agent-lifecycle.md).

## Blocked on herdr (needs a live schema probe)

All three wait on a `herdr api schema --json` dump from a live 0.8.x to
verify the methods exist before building on them:

1. **Workspace reaping.** Mode-B spawns leak workspaces (documented in the
   spawn docs); an idle-workspace TTL reaper needs a verified
   workspace-close method. The same probe should check for a **native
   pane-create**, which would make `workspace_id` spawns truly "join the
   team" instead of new-workspace-same-cwd.
2. **Agent stop/restart endpoint.** The lifecycle doc's admitted gap — no
   verified agent-stop method on herdr's surface.
3. **`agent.prompt` wait semantics.** If `wait: true` blocks until the
   agent finishes, `ask()` could block on the rpc instead of file-polling.

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
16. **Security tier for shared instances:** hash client tokens at rest
    (mint-once-show-once, like child secrets), rate-limit auth attempts,
    and an audit trail for admin actions (kick/mint/revoke/env writes).
17. ~~**Live pane viewer.**~~ Done: `GET .../panes/{pane}/screen` long-polls
    by content version; SDK `watchScreen()`/`type()`/`keys()`; PaneViewer
    organism + demo Pane page (interactive — trust dialogs answered live).
18. ~~**Codify manual verification into CI.**~~ Done: 12-test Playwright e2e
    suite (gate/console/pane/kick vs the devstack) in ci.yml on every push/PR,
    plus a weekly real-herdr wire probe (herdr-drift.yml) that auto-files a
    `herdr-drift` issue on failure.
19. **Demo Copilot auth passthrough.** Seed COPILOT_GITHUB_TOKEN into the
    env registry (kind `copilot`) at container boot so demo agents run
    authenticated instead of stopping at /login.

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
