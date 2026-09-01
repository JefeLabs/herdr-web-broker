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
    since `--conversation` only RESUMES an existing id — WT-2 confirmed
    live on 2026-08-29 that it cannot mint one), and `opencode`
    (`--session`-pinned,
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
    what could not be settled offline. WT-1 (does `pane.send_input`
    bracket multi-line paste?) and WT-2 both ran live on 2026-08-29
    against herdr 0.8.2 and are ANSWERED: send_input DOES bracket, so
    the feared early-submission bug does not exist; agy does not mint.
    Still open are WT-4, WT-5 and WT-6, which have no probe files yet.

25. **Lifecycle-determinism follow-ups.** Deferred from item 24's final
    whole-branch review, ordered by what a maintainer would hit first.
    (a) ~~**Teardown clears one index, not both.**~~ **Done 2026-08-29.**
    `demolishOwned` cleared `AgentIndex` but left `WorkspaceIndex`, while
    `broker.workspace.close` clears both — the sibling stores disagreed at
    that one call site. Session names are deterministic, so a user who tore
    down and re-authenticated got the same name back and inherited the stale
    rows; since `resolveCwd` falls back to the index when herdr doesn't list
    a workspace, such a row could hand a repo endpoint a path from a session
    that no longer exists. Fixed by giving `WorkspaceIndex` the
    `removeSession` its sibling already had and calling it beside
    `agents.removeSession`. Both teardown routes (session DELETE and the
    kick path) share `demolishOwned`, so one fix covers both. 3 tests: the
    new index method including sibling-session isolation, and an integration
    test through the teardown route seeding BOTH a listed and an unlisted
    workspace row — the unlisted one is what survived even a per-workspace
    cleanup, because nothing iterated it — then re-authenticating to prove
    the reborn session starts clean. (b) ~~**`ask` and `wait` resolve cwd
    differently.**~~ **Done 2026-08-29.** `resolveCwd` preferred HERDR's
    cwd and fell back to the index; `waitAgent` read the index directly.
    On a mode-C worktree spawn — where the index deliberately holds the
    CHECKOUT path — the two could disagree, yielding different `cwdSlug`
    values and so two different `claude` transcript paths for ONE pane.
    It degraded safely (wrong slug → no file → status tier), which is why
    it shipped and equally why nothing caught it. Fixed by extracting the
    shared `lookupCwd` — herdr's view first, index as fallback — and
    pointing both callers at it. It is deliberately NON-THROWING, because
    `wait` could not simply adopt `resolveCwd`: that throws
    `unknown_workspace` and would turn a currently-succeeding wait into an
    error. `resolveCwd` is now a thin throwing wrapper over it, so each
    caller keeps its own failure mode while both agree on WHICH cwd.
    2 tests: one seeding a transcript only under herdr's cwd while the
    index holds a different one, so the resolver that won is observable in
    `evidence`; one asserting a wait with no resolvable cwd still succeeds
    — mutation-checked by pointing `wait` at the throwing resolver and
    watching it go red.
    (c) ~~**`GET .../agents` carries no `evidence`.**~~ **Done 2026-08-29,
    as an OPT-IN.** The spec claimed the list carried evidence; only
    `wait`'s reply and `ask`'s `agent_unresponsive` details did. It was
    left open as a design decision rather than an oversight, and the
    decision went to `?evidence=1` — because the default list is a FREE
    registry read (push-fed, no disk, no herdr) and it is the endpoint a
    UI polls, while evidence costs one transcript read per agent: a 256KB
    tail for `claude`, two file reads for `agy`, a SQLite open/query/close
    for `opencode`. Paying that per poll on the hottest path was the wrong
    trade; `?fresh=1` on this same handler already set the precedent for
    opting into cost. When asked, the one `workspace.list` is hoisted out
    of the loop (cwd is per-workspace, not per-agent) and the transcript
    decides `status` as well as naming the tier, exactly as `wait` does.
    The bound is the agent's own `startedAt`, not a turn boundary — a
    roster has no turn. RUNTIME ONLY: a federated child's transcripts live
    on the CHILD's disk, so `evidence` is left ABSENT for a remote
    instance rather than reported as `"status"`, which would be
    indistinguishable from "looked and found nothing" — the same ambiguity
    that hid 25(b). Documented in the API catalog, so the generated
    OpenAPI and the demo's spec page carry it. 4 tests, including that the
    default roster gains no field AND makes no herdr call, and that a
    federated instance omits rather than fabricates.
    (d) ~~**`agy`'s concurrent-same-cwd collision.**~~ **WON'T FIX,
    answered 2026-08-29.** The `startedAt` bound rejects a transcript older than
    the agent, so a STALE map entry can't be claimed, but two `agy`
    agents live in one cwd still resolve to the same conversation. WT-2
    was the thing that could have closed it, and the answer is no: agy
    ACCEPTS `--conversation <fresh-uuid>` — it reaches the terminal
    title — but mints nothing under that id within 45s, and
    `last_conversations.json` never learns it. So there is no
    launch-time-known path to pin the way claude's `--session-id` and
    opencode's `--session` give, agy stays on cwd-map + `startedAt`
    discovery, and `cli-profiles.ts`'s agy profile keeps no `pin` entry.
    Two agy agents in one cwd remain ambiguous by construction; the
    probe now pins that answer and goes red only if agy starts minting.
    (e) ~~**`opencode`'s `terminal.done` is dead config.**~~ **Done
    2026-08-29.** `parseOpencode` keyed off the presence of
    `time.completed` and never took a `profile` argument at all, so a
    `[[cli.profiles]]` override of that vocabulary silently no-opped —
    unlike `claude`/`agy`, where the same block is live. The builtin made
    it worse than dead by DECLARING `done: ["completed"]`, which reads
    like live config but names the FIELD (`time.completed`) rather than
    anything the parser branches on. Completion here is structural, so
    the one real vocabulary is the ROLE: `done` now names which roles'
    completed rows settle a turn, defaulting to `["assistant"]` when a
    profile omits `terminal` so a bare profile keeps builtin behavior.
    The builtin is corrected to `["assistant"]`. 3 tests: an override
    widening `done` to `user` takes effect, narrowing it to `[]` withholds
    done from an assistant row that would otherwise report it (the
    complement — proving the set is consulted rather than merely present),
    and a profile with no `terminal` block still resolves done.
    (f) **`transcript.ts` mixes layers.** It holds the pure parsers, the
    pure `decideTurn` tier, AND fs/sqlite I/O, against the spec's "all
    I/O stays in thin shells". A `transcript-resolve.ts` split would
    honor that; not worth churning while the format work is still live.
    (g) ~~**No integration test** covers `GET .../orphans` or teardown's
    `unrecognized` field.~~ **Done 2026-08-29.** `classifySession` was
    fully unit-tested; the HTTP wiring was not. Two tests now cover it.
    The orphans route asserts all three buckets from one fixture — a
    workspace both indexed and live (`adopt`), one indexed that herdr no
    longer lists (`forget`), and one live the broker never indexed
    (`orphans`). The teardown test asserts `unrecognized` is only the
    un-indexed workspace AND that it is still closed (report-never-reap:
    the herdr process dies immediately after either way, so declining to
    close would only turn a graceful close into an abrupt kill).
    That first assertion doubles as an ORDERING guard for 25(a), which
    added `index.removeSession` to the end of the same function:
    `unrecognized` is computed against the PRE-teardown index, so
    clearing it any earlier would make every live workspace read as
    unrecognized. Both tests were mutation-checked — they passed on
    first run, as a coverage gap should, so each was confirmed against a
    deliberately broken implementation.

26. ~~**Publish the SDK — it is not installable.**~~ Done for 0.2.0
    (2026-08-28); the AUTOMATED path is not. All FOUR library packages
    are live on npm, public, at `latest` — `@jefelabs/herdr-broker-client`,
    `-react`, `-ui`, and `-module`, which joined in bae7fd5 after this
    item was written and which the original text therefore undercounts
    as three. Installability was verified from a clean directory rather
    than assumed: the four resolve, `-react`/`-ui` dedupe to a single
    `-client`, every entry point and subpath (`/events`, `/types`,
    `/styles.css`) imports, and a consumer `tsc` under `nodenext` with
    `skipLibCheck: false` exits clean. The adoption barrier this item
    names is gone.

    What remains is the unpushed button itself. `NPM_TOKEN` now exists
    but is not a token that bypasses 2FA, and the two tag-triggered
    runs died for two different reasons — 2026-08-22 `ENEEDAUTH` (no
    secret yet), 2026-08-28 `EOTP` (secret present, provenance signed,
    then refused for want of a one-time password). 0.2.0 consequently
    went out by hand and carries NO provenance attestations, the one
    thing release.yml exists to add. The local path has since begun
    demanding an OTP as well, so it needs a maintainer at a TTY to
    complete npm's browser auth. 0.3.0 shipped that way on 2026-08-29 —
    all four packages live, verified against the registry ORIGIN rather
    than the CDN, and the published module ABI confirmed to carry the
    allowlist correction rather than the removed denylist text it had
    been advertising.

    **Interactive OAuth is the decision for now (2026-08-29), not an
    outstanding task.** Note precisely what is manual: the AUTH, not the
    publish. `release:local` still does the publishing — preflighting
    every version against the registry origin, then publishing in
    dependency order — and what a human supplies is npm's OAuth browser
    round trip instead of a stored credential. An Automation or granular
    token in `NPM_TOKEN` would replace that round trip and make a tag the
    whole release. The accepted costs are that published versions carry
    no provenance attestations, and that a release needs a maintainer at
    a terminal. Revisit when provenance matters to a consumer, or when
    releasing outgrows one pair of hands.

    There is a security argument for the current arrangement, not only
    convenience: no long-lived publish credential exists to leak. The
    token that would remove the round trip is exactly the token that,
    once stored in CI, can publish without a human.

    Both publish paths are now preflighted (b5347c5). Every version is
    checked against the registry — origin reads, not the CDN, which lies
    for a minute after a publish — before the first package ships, so a
    taken version aborts the run instead of publishing half the set and
    stranding the rest behind a version number npm will never re-issue.

    This item's own `/v1` warning has come true rather than expired: the
    aliases stopped being cheap the moment 0.2.0 became installable, and
    are now a compatibility obligation to real consumers. (The original
    text cross-referenced this as "item 25's API-versioning window";
    that numbering is stale — the prefix landed in 78c77b2.)

27. ~~**Spawn readiness — prove the shell is at its prompt, don't guess.**~~
    **Done 2026-08-29.** `src/spawn-readiness.ts` — `readinessSentinel()`
    (pure: the command to send and the string to await, with a per-spawn
    random id so a reused pane's stale echo can never match) and
    `awaitShellReady()` (the I/O shell, best-effort by construction: it
    returns whether the shell proved ready and never throws for a readiness
    failure). Called at one site in `spawn()`, after the pane exists and
    before the `agent.start` retry, so all four paths are covered —
    mode A with env, mode A without, mode B `pane.split` and mode C
    worktree, the last three of which settled for ZERO time before this.
    The env drop file composes into the same `send_input`
    (`. <drop>; rm -f <drop>; printf '<marker>\n'`), so sourcing the env
    and proving readiness cost one round trip and the shell's sequencing
    guarantees the order. `[spawn] readiness_timeout_ms` (default 5000, 0
    disables) replaces `envSettleMs`, which was a test-only override wired
    to no config and is deleted. The `agent_pane_busy` retry stays as the
    floor. 15 tests: 10 on the pure policy, 5 driving it through
    `broker.agent.spawn` against FakeHerdr (order, degrade-on-timeout, the
    composed env line, mode B, marker uniqueness).
    **CORRECTED 2026-08-29 — the first version did not work, and the
    measurement that appeared to prove it was measuring the wrong thing.**
    `readinessSentinel` built `printf '<marker>\n'`, putting the marker
    verbatim inside the command being typed. WT-7 had established that
    `pane.wait_for_output` matches the pane's OWN ECHO, so the wait fired on
    DELIVERY, not execution: `awaitShellReady` returned true against a cold
    pane and `agent.start` then raced exactly the window this item exists to
    close. The "2–5ms, mean 3ms" recorded here was the echo round trip — a
    figure that should have read as impossible for a login shell reaching its
    prompt, and instead read as a triumph.
    Fixed by shaping the marker so it CANNOT appear in its own command:
    `printf '%s%s\n' __herdr_ready_ <id>` echoes with a space and outputs
    joined, so matching the joined form can only be satisfied by execution.
    Measured on cold panes, A/B on the same lifecycle: old shape matched in
    ~106ms and `agent.start` immediately after failed `agent_pane_busy`; new
    shape matched in ~520ms and `agent.start` succeeded, 4/4. So real
    cold-shell readiness is ~525ms, still an order of magnitude under the
    5000ms timeout and well under the up-to-4s retry it displaces.
    The root error was not the code. The spec reasoned "when it echoes, the
    shell is provably at its prompt", and WT-7's answer — yes, it matches the
    echo — was read as CONFIRMING that when it is precisely what breaks it. A
    probe answered its question correctly and the answer was misapplied; see
    test/wire/README.md. Found by the smithagents session, reproduced here
    before fixing. No unit test could have caught it: FakeHerdr does not model
    echo-versus-output, so the regression guard has to be a wire test.
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
    **WT-7 IS GREEN — this is unblocked (2026-08-29, herdr 0.8.2).**
    `pane.wait_for_output` matches the pane's OWN echoed input, on
    `visible` AND `recent`, returning `matched_line` as the echoed
    command itself. The inference recorded here — that a matcher taking
    `source: "visible" | "recent"` must be reading the rendered buffer,
    since a program-output tap would have no use for a screen/scrollback
    distinction — was correct. The sentinel design is viable as written
    and the fallback (keep the retry as the sole mechanism) is not
    needed. Build it. Note this also means the existing readiness settle
    window from roadmap 24 does not help here: it samples
    `interactive_ready` AFTER `agent.start`, to catch a CLI that renders
    then dies. Two windows, and the shipped one sits on the far side of
    this failure.

29. **`localEndpoints` / provisioner as a supported seam.**
    Write-up: [docs/local-endpoints-seam.md](docs/local-endpoints-seam.md).
    Two `DaemonOptions` fields decide where sessions come from, and together
    they are the point at which this broker can serve sessions backed by
    something it did not discover itself. `localEndpoints` does not hint at
    discovery, it DISPLACES it — passing it forces `HERDR_SOCKET_PATH`, the
    default socket and the sessions dir all to `undefined` — and
    `SessionProvisioner` returns a `HerdrEndpoint` (`{session, socketPath}`,
    two strings) rather than a process handle, so nothing downstream ever
    learns how a session came to exist. An alternative backend does not have
    to impersonate a herdr binary; it has to produce a socket that speaks
    herdr's wire.
    Already load-bearing: the devstack rides it (which is why e2e needs no
    Docker), and `daemon`/`ws-client`/`federation`/`projection` tests all boot
    through it — the last two twice each, for a parent and a child.
    A prospective adopter named the real gap sharply: there was no declared
    contract for what a backend must implement — only an implementation that
    assumes herdr and a test fake that assumes it too, enumerating almost
    nothing because each test registers just the verbs it needs. The write-up
    now lists all **18 methods**, grouped by what breaks without each, with
    the practical floor called out (`ping` + `agent.list` is enough to attach
    and serve a roster) and the fact that a partial backend fails per-endpoint
    rather than globally. `test/backend-contract.test.ts` re-derives the
    surface from `src/` on every run and fails in BOTH directions, so the doc
    cannot drift from the code.
    Declaring it SUPPORTED is four commitments, of which only one is work:
    publish the two types; **assert the displacement rule** (untested today —
    every test passes endpoints and none checks discovery went off); restate
    the `u-` namespace invariant for third parties, since
    `HerdrProvisioner`'s structural guard does not extend to someone else's
    implementation; and be honest that the consumer is an in-process embedder
    importing from `dist/`, because the broker is not published to npm.
    **Announced vs placed is a TAXONOMY, and this seam is UNGATED.** A child
    dials out to tell the parent where it is, because its location cannot be
    known in advance; a container you started is known at creation. Announced
    hosts need federation (`pair`, the child-initiated tunnel), placed hosts
    need this seam — two halves of one problem, which is why `HerdrEndpoint`
    carrying only `{session, socketPath}` lets them converge.
    An earlier version of this item used that taxonomy as the trigger, with
    the condition "true the first time a session's socket is known before the
    session exists". That was wrong twice over. It had been satisfied since
    2026-08-22 — `HerdrProvisioner.start()` computes `socketPath` before
    spawning `herdr server` — so it described the status quo. And the NAT flip
    is a different condition entirely: recorded in the smithagents 2026-08-27
    assessment as "the product must drive agents on other people's machines /
    roaming laptops over NAT", which is the ANNOUNCED population, served by
    federation rather than by this seam. It is a product judgement, not
    observable, and the answer to "possible, necessary or cheaper" is
    CHEAPER — the hosted design already answers remote execution via
    cell-per-tenant Fargate.
    So the flip gates adoption of the broker's FEDERATION, not this seam,
    which has no trigger. That is the honest status: documented,
    contract-bound, usable without code change, and nothing in the product
    today requires it.

28. ~~**Module system — capabilities, not internals.**~~ Done. Spec:
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
    down for one optional extension.
    Modules have no TYPE — "git module"/"file module" are descriptions
    the broker cannot verify, and metadata that looks like a constraint
    but is not one is worse than none. Instead a module DECLARES
    capabilities (`git.read`, `git.write`, `files`, `workspaces`,
    `agents`, `rpc`, `events`) and the broker grants the intersection of
    that and the operator's config list, CONSTRUCTING `api` from the
    grant — an ungranted capability is `undefined`, not a function that
    throws. Least privilege by construction, plus an honest install-time
    disclosure: a module that later wants `git.write` shows up in a diff.
    Explicitly NOT a sandbox — node:fs stays one import away. Flat by
    design (no dependency graph, no delegation, no runtime grants), and
    the capability NAMES join the ABI, so granularity is decide-once.
    DECIDED: modules are plain `.js` — the broker `import()`s the path
    and owns no compile step, loader hook or transpiler; Node's native
    type-stripping covers only a subset of TS syntax, so `.ts` would mean
    shipping a compiler or supporting a confusing partial dialect.
    Authors wanting types write TS and build, or use a JSDoc `@type`
    against the published `packages/module` types. DECIDED: `api.git.raw`
    is KEPT — enumerating safe subcommands is tighter and would guarantee
    this feature misses the need that motivated it, since an operator
    adding THEIR git functionality cannot be limited to the subcommands
    we anticipated; the guards are the argv array (no shell to inject
    into), the argv[0] denylist, and its being gated behind `git.read`.
    It stays the sharpest edge here and wants its own review pass.
    DECIDED: `api.agents.ask` participates in the core per-pane lock —
    it calls the same `ask()` wrapper core routes call, not `askInner`,
    so it takes `deps.askLocks` and gets the same `pane_busy`. Not
    defensive plumbing: two concurrent asks on one pane interleave two
    answer-file contracts at the same agent, and the symptom (an answer
    arriving for the wrong question) is close to undebuggable. The lock
    is per PANE, not per caller, so a module holding it blocks core and
    vice versa — correct, since the constraint belongs to the agent.
    Falls out of it: `broker.ask.completed` must be emitted AFTER the
    lock releases, or a handler reacting to it cannot ask again on that
    pane. General rule instantiated: where core holds an invariant, the
    module API hands over the GUARDED function, never the guarded thing.
    DECIDED, closing the last three: NO module-emitted events — a module
    may CONSUME herdr and `broker.*` events but not publish them, since
    module-to-module eventing makes the ABI a message bus and drags in
    delivery ordering, cycle detection and inter-module failure semantics
    as permanent obligations, in exchange for a capability nobody has
    asked for. Modules load at BOOT ONLY — config.toml keeps hot-reloading
    `client_tokens`, but `[[modules]]` is exempt, because re-importing
    mid-flight leaks whatever the old instance closed over and a route
    table changing under live requests is the wrong trade for a feature
    whose appeal is predictability; `GET /admin/modules` reports the
    loaded set so drift is visible. And the capability split STAYS
    asymmetric: `git` splits read/write because its mutating verbs are the
    audited, confirm-gated ones, so the line marks a real change in blast
    radius, while `files` has no equivalent boundary — both directions sit
    behind the same realpathSync escape guard, so splitting it would add
    an ABI name distinguishing nothing. The rule, for whoever adds the
    eighth capability: SPLIT WHERE THE GUARANTEES DIFFER, NOT WHERE THE
    VERBS DO. Coupled to item 26 — the ABI wants to ship as a published
    `packages/module` alongside the SDK, not after it.
    SHIPPED, with one correction found by a security review DURING
    implementation, recorded because the reasoning was wrong and not just
    the code: `api.git.raw` originally guarded argv[0] against a DENYLIST
    of subcommands. Git accepts GLOBAL OPTIONS there, and
    `git -c alias.x='!sh …' x` executes a shell — verified against real
    git, not theorised. The argv array defends against metacharacter
    injection; it does nothing when git itself spawns the shell. The same
    denylist omitted commit/merge/apply/am/update-ref/branch/config, so a
    `git.read` grant could mutate freely — the read/write split defeated
    by its own escape valve. Root error was the denylist itself: git's
    surface is far too large for "block the dangerous ones" to ever be
    complete. Inverted to an ALLOWLIST of read-only subcommands; argv[0]
    must match a bare-subcommand shape, which blocks every
    pre-subcommand global; exec-bearing options are refused wherever they
    appear. `raw` is therefore READ-ONLY, and mutations go through the
    audited verbs — which is what the design always said, it just was not
    true until now. This NARROWS the earlier "keep raw" decision: raw is
    kept, but cannot mutate.
    Stayed honest: modules are NOT sandboxed (node:fs is one import away
    — capabilities make the safe path narrow, they do not confine);
    installable only from config.toml, with a test asserting five
    plausible install routes all fail; boot-only, no hot reload; a failed
    module 404s and the broker still boots; and `packages/module` remains
    UNPUBLISHED until item 26.

## Gateway-review gaps (2026-08-30)

Two items from reviewing an external gateway design note — an independent
design for the same product, written against herdr upstream rather than
against this repo. Most of what it proposed is already built here, usually
with more evidence behind it. These are the two it was right about.

30. **Token usage and cost — nothing reads it today.**
    The note proposed a per-agent `usage` route read from the CLI's own
    transcript. The gap is real and total: no route, no accounting, no
    price table, and the word `usage` appears nowhere in `src/`. A fleet
    operator can see what every agent is DOING and nothing about what any
    of it cost — on the one endpoint class where the answer is already
    sitting on disk.
    The transcript machinery items 24/25 built is the right place to read
    it from, and it is NOT free reuse — which is the part worth recording
    before someone starts and discovers it late. `readTail`
    (`src/transcript.ts:243`) SEEKS to `size - TAIL_BYTES` (256KB) and the
    comment above it states the reason plainly: "only the tail matters: a
    turn's terminal record is at the end". Turn state is a LAST-RECORD
    question. Usage is an AGGREGATE over the whole file. Pointing the
    existing reader at it under-counts every session past 256KB and
    reports a number that looks right and is low — the worst failure
    shape available, and one no test would catch without a fixture built
    to exceed the cap.
    (a) **Which kinds can answer at all.** Availability follows the
    `transcript` key, so `copilot` is excluded by construction (no
    profile entry, status tier) and stays excluded until WT-5 clears.
    For the four that have one, only `claude`'s store is a confident yes
    — per-message token counts are what its JSONL is known to carry.
    Whether `agy`'s transcript, `opencode`'s `message.data` blobs and
    `codex`'s `rollout-*.jsonl` record counts AT ALL is unverified, and
    the repo's own rule applies: a kind whose format is unverified ships
    with the capability ABSENT rather than stubbed. Registered as
    **WT-10** in `test/wire/README.md`; no probe file is written yet, so
    it joins WT-6 as the second open question with nothing behind it.
    What it has to answer is narrow — per kind, does a completed turn
    record counts at all, under what field names, are the token classes
    kept separate or pre-summed, and is a row a per-turn DELTA or a
    running session TOTAL. That last distinction decides whether
    accumulation is a sum or a max, and getting it backwards is wrong in
    a plausible-looking way on every multi-turn session.
    (b) **Aggregate shape, and the cursor the broker does not have.**
    The note's advice is to tail by byte offset and never re-parse. That
    is right and it is a NEW mechanism here: `readTail` is deliberately
    stateless — no cursor, no per-pane bookkeeping, safe to call on any
    poll because it always answers from the end. Accumulating requires
    remembering a byte offset and a running total per pane, surviving
    pane close, and handling the case `decodeBytesRead` already guards
    for one read (a truncate racing the reader) across many. Re-reading
    the whole file per request is the honest alternative and is fine
    until it isn't; the decision belongs with real transcript sizes, not
    in advance.
    (c) **Store raw, price at read time.** Do not collapse to two
    numbers. Anthropic bills input, output, cache-creation and cache-read
    at materially different rates, so summing them produces a cost figure
    wrong by a multiple, and a price table baked into the accumulator
    makes every historical row unrepairable when prices move. The shape
    this repo already uses twice fits exactly: builtins in code,
    `[[...]]` rows in config.toml overriding by key, `source:
    "builtin" | "config"` on every entry — `model-registry.ts` and
    `cli-profiles.ts` are both instances. A price table is the third.
    (d) **Runtime only, and absent rather than zero.** A federated
    child's transcripts live on the CHILD's disk, so usage inherits
    25(c)'s ruling without change: the field is OMITTED for a remote
    instance. Reporting `0` would be indistinguishable from a genuinely
    idle agent — the same ambiguity class that hid 25(b) — and here it
    is worse, because zero cost is a number a caller will happily sum.
    (e) **Its own route, not a field on the roster.** 25(c) set the
    precedent and the cost argument is stronger here: `GET .../agents` is
    a free push-fed registry read and the endpoint a UI polls, evidence
    already costs a 256KB tail per agent behind `?evidence=1`, and usage
    costs strictly more than evidence. It does not belong on that
    handler at any opt-in level.
    No condition gates this one — it is unbuilt because nobody asked for
    it, not because anything is blocking. The cheapest honest first
    slice is `claude` alone, whole-file re-read, raw payload stored and
    priced at read time, absent everywhere else.

31. ~~**Resume — the broker mints a session id, hides it, and deletes it.**~~
    **Done 2026-08-31**, on the shape WT-11 settled the day before. Spawn
    takes `resume: {session_id | pane_id}`, `GET .../sessions/{s}/resumable`
    lists what can be reattached, and a `ResumableIndex` keeps the id after
    the pane that held it is gone. What follows is the reasoning, kept
    because each sub-item became a decision in the implementation.
    **What shipped, against (a)-(e).** (a) the ids are reachable — the
    resumable listing is where a caller finally sees one, deliberately NOT
    added to `GET .../agents`, which is a free push-fed registry read and the
    endpoint a UI polls. (b) `ResumableIndex` is keyed by SESSION ID, not by
    pane, because that is the only identifier that survives the pane and the
    only one `--resume` takes; `AgentIndex.remove`/`removeWorkspace` now
    return what they removed so the conversation can be archived on the way
    out. (c) the pin is KEPT and `--fork-session` added, per WT-11. (d) only
    `claude` has a `resume` profile entry; every other kind answers
    `resume_unsupported` rather than being sent a guessed flag — WT-2's agy
    result is why. (e) built as described.
    **Three calls made in the building that the item did not anticipate.**
    A resume into a different cwd is REFUSED (`bad_request`): the CLI keys
    transcripts on the directory, so a resume from elsewhere starts a fresh
    conversation wearing an old id and looks like success from every angle
    the broker can see — the most convincing lie available here. Omitting
    `cwd` and `workspace_id` defaults to the conversation's own directory,
    which makes the common case one field. And `worktree.remove` archives
    NOTHING, unlike `workspace.close`: it deletes the checkout, so an entry
    would list a conversation that fails the moment anyone picked it.
    Teardown purges the session's archive for the same reason.
    An agent with no pinned id records nothing — an unpinnable CLI has
    nothing to resume BY, and a listing entry that cannot be acted on is
    worse than none.
    **Verification status — read this before trusting the item above.**
    Unit-tested (9 tests, mutation-checked) and NOT wire-verified. The
    SHAPE is safe: it rests on WT-11's sub-questions 2, 3 and 4, which are
    direct observations — the record forks, the pin collides, the fork
    lands under the broker-minted id — and none of them needs the model to
    say anything. What is NOT established is that a resumed agent comes
    back with its context.
    **WT-11's "yes" to that was a false positive, found 2026-08-31.** The
    probe searched post-resume transcript BYTES for a token, and
    `--fork-session` COPIES the parent conversation into the new record, so
    the search succeeds whether or not a model ever spoke. It was proven by
    forking with a prompt that never mentioned the token, using an agent
    that was not logged in: the token still landed, on two copied lines,
    with every assistant row `<synthetic>`. The probe now requires the
    token in a REAL model's row timestamped after the recall prompt, and
    refuses to measure when the seed conversation has no model output.
    **WT-12** (`test/wire/resume-mode-d.wire.ts`) ran the same day and
    could not reach its question either: its seeding `ask` returned
    `agent_unresponsive` with `evidence: "transcript"`. Both are blocked on
    the same thing, which is item 33, not on anything in this item.
    **Not fixed here:** (f) below, still.
    The original reasoning, which stands as the case for having built it:
    the broker identified unexpected agent states well and could act on none
    of them — `grep -i resume src/` returned three comments and zero code.
    The evidence tier can PROVE an agent finished its turn and died without
    answering (item 24), and the only remedy on offer was a fresh spawn with
    no memory of the conversation that was in flight. Identification without
    continuation.
    (a) **The id exists and is unreachable.** `spawn` mints
    `randomUUID()` when the kind has a pin flag
    (`src/workspace-ops.ts:648`) and stores it as `AgentMeta.sessionId`
    (`:714`). It is read by exactly one consumer — transcript resolution
    — and returned by NO endpoint: `sessionId` appears four times in
    `src/`, three of them comments. A caller cannot learn the id of the
    conversation it is having.
    (b) **The row's lifetime is bound to the wrong object.** Agent stop
    deletes it (`:843`) for a correct reason, stated inline: a reused
    pane id must not inherit a stale pointer for a future transcript
    read. Correct for transcripts, exactly backwards for resume — a
    resumable conversation OUTLIVES its pane, which is the same shape as
    the "worktrees outlive panes" caution in the same review. The fix is
    not to stop deleting; it is that a transcript pointer and a
    resumption handle have different lifetimes and are currently one
    field.
    (c) **`--resume` is already reachable, by nobody — and the collision
    is REAL.** `args` go verbatim to `agent.start` (`:480`, `:657`) and
    the broker never interprets them, so a caller holding an id could
    pass `args: ["--resume", "<id>"]` today. Two things stop it: (a), and
    the collision `:648` creates by appending the pin flag with a FRESH
    uuid. WT-11 confirmed the CLI rejects that pairing outright —
    *"--session-id can only be used with --continue or --resume if
    --fork-session is also specified"* — and, worse, that **`agent.start`
    STILL RETURNS SUCCESS**: herdr only TYPES the command, so the CLI
    rejects the argv and exits to the shell while the broker records a
    clean spawn. A spawn that succeeded and an agent that never existed
    are indistinguishable from this side, which is its own small item.
    The error also names the fix, so the rule is not "suppress the pin"
    as first written — see (e).
    (d) **Per-kind syntax is a wire fact, not a given** — **WT-11**,
    probed for `claude` in `test/wire/claude-resume.wire.ts` (the other
    three kinds still need their own; the candidate syntax for each is
    recorded in that file's `RESUME_SYNTAX` table, which is what becomes
    the profile field in (e) once answered — an unverified profile entry
    reads like live config, the trap 25(e) closed). Not one of those
    shapes is verified, and they are not even uniform — a flag, an
    `=`-joined flag, a different flag name, and a SUBCOMMAND — which is
    the concrete reason (e) stores the flag instead of assuming one.
    WT-2 is the standing precedent for why acceptance proves nothing:
    `agy` ACCEPTS `--conversation <uuid>`, reaches the terminal title
    with it, and mints nothing. Accepting a flag is not honoring it.
    (e) **Shape, now evidence-backed.** A `resume?: { flag, style }`
    field beside `pin` on `CliProfile` — same builtin-plus-
    `[[cli.profiles]]` table as everything else per-kind — and a spawn
    **mode D** that reattaches where A/B/C start fresh. WT-11 settled
    which of the two possible modes D it should be:
    **fork and KEEP the pin** (`--resume <id> --fork-session`, the
    combination the CLI's own error names), not suppress the pin. It
    carries prior context — the resumed agent produced a token given to
    a conversation whose pane had already closed, reproduced across two
    runs — and the fork lands under **the id the broker minted**, so
    `AgentMeta.sessionId` still points at the live record and nothing has
    to be re-captured after spawn. Suppressing the pin would have forced
    the broker to adopt an id it did not mint, giving up the
    launch-time-known path that `pin` exists for; the fork keeps it.
    The original record is left byte-identical, so a resume never
    disturbs the evidence the previous turn is read from.
    Keep the id paired with what KIND of handle it is rather than
    reconstructing a command from a bare string; the review's
    `sessionRef {kind, value}` warning applies directly, and
    `codex resume [ID]` versus `claude --resume <id>` is the same trap
    `pin` already avoids by storing the flag rather than assuming one.
    (f) ~~**The other gap this exposes: identification is pull-based.**~~
    **Detection done 2026-08-31 — push, not poll. The boot sweep is
    deliberately still not built; see the end of this item.**
    **Reproduced live 2026-08-30** while tearing down WT-11's stack: the
    broker listed five workspaces where herdr had one, and had done so
    across a daemon restart, with nothing announcing the divergence. The
    stale rows themselves are item 32 — a defect on the removal path, not
    an argument for this — but the fact that the disagreement sat there
    unremarked until somebody asked is precisely this item.
    Narrowed 2026-08-31: item 32 now covers BOTH removal paths, so this no
    longer inherits the stale-row example. What is left is the case the
    broker never observes at all — a reap after a herdr-side close or a
    crash, with no broker call in the chain to notice it — and the fact
    that nothing announces the divergence at boot.
    `classifySession` is called from two sites only
    (`src/http.ts:162` teardown, `src/workspace-ops.ts:144` the orphans
    route), both on demand, neither at boot. The indices are file-backed
    and survive a daemon restart, so after one the persisted index and
    herdr's live truth can disagree until somebody asks. Nothing
    announces divergence. Not part of mode D, recorded here because a
    resume verb makes a boot-time reconciliation pass worth having:
    detecting a diverged row is only useful once there is something to
    do about it.
    **What shipped.** The broker now subscribes to herdr's
    `workspace.closed` — a wire-verified type that was in `SUB_TYPES` for
    clients all along while the broker's OWN channel asked only for
    `pane.agent_detected`, `pane.created`, `pane.exited` and per-pane
    status. The signal was on the wire and nothing was listening. It
    carries the id, so it is a NAMED reap rather than a "go re-list" nudge;
    a frame without one maps to nothing, because a handler guessing which
    row to drop is worse than the stale row it would be fixing.
    It both heals and announces. `broker.workspace.reaped` joins
    BROKER_EVENTS with `{session, workspace_id, indexed}`, and `indexed`
    is classifySession's adopt/orphan split arriving as a push: true means
    a row of ours, cleared; false means an orphan — announced, untouched,
    which keeps report-never-reap intact on this path too.
    **The race is the whole engineering.** herdr emits the event the
    instant it closes a workspace, so it lands INSIDE the
    `broker.workspace.close` that caused it. A handler that merely removed
    the row could win the window between that call's herdr round trip and
    its archiving, take the cwd away, and make `resumable.record` drop the
    conversation — silently, since it drops anything it cannot pair with a
    cwd. So all three callers now share one `reapWorkspaceRow`
    (archive-then-remove): whichever arrives first does the WHOLE job and
    the loser finds nothing left to do. Mutation-checked — splitting the
    helper fails both archiving tests, including one that fires the event
    from inside the close handler.
    `LocalHerdr` takes a CALLBACK rather than the index: it holds a
    Registry and no other broker state, and the daemon late-binds the hook
    because LocalHerdr is constructed before `ops` and before the bus.
    A reap in that window is not healed, the same degrade as a downed event
    channel — this is a heal, never a guarantee.
    **Still not built, on purpose:** the boot-time sweep. `classifySession`
    is still called from two on-demand sites only, so a divergence that
    predates this daemon — rows persisted by an EARLIER process, which is
    the original WT-11 observation — is still not announced at startup.
    Push detection covers every reap that happens while the broker is
    watching; it cannot cover one that already happened. That remainder is
    small and honest, and it is what is left of this item.
    Ordering against item 30: this one first. Usage tells an operator
    what a session cost; resume makes every state the evidence tier
    already detects ACTIONABLE, and that tier is the most expensive
    thing in the repo to have built.

## Index/herdr divergence (2026-08-30, found tearing down WT-11)

32. ~~**A workspace herdr has already reaped can never leave the broker's
    index.**~~ **Done 2026-08-31.** `broker.workspace.close` is idempotent:
    `workspace_not_found` from herdr no longer throws past the index
    removals, and the response carries `already_closed` beside `closed`.
    Reproduced 4 times out of 4 WT-11 runs, then confirmed against the
    live pair: herdr's own `workspace.list` returned `[w1]` while
    `GET .../workspaces` returned five, and `GET .../orphans` named the
    difference exactly — `forget: [w2S, w2V, w2X, w2Z]`, `orphans: [w1]`.
    The classifier was right. Nothing consumed it.
    The chain is short and every link is a documented, first-class route.
    `DELETE .../agents/{pane}` on a workspace's only agent closes the pane;
    herdr then reaps the workspace, which is wire truth this repo already
    records ("herdr reaps a workspace when its last pane closes",
    federation probe). `stopAgent` clears the AGENT row and never touches
    the workspace index. The row is now stale, and the only two calls that
    could remove it cannot: `deps.index.remove` is reached from exactly two
    sites, `broker.workspace.close` (`src/workspace-ops.ts:131`) and
    `broker.worktree.remove` (`:165`), and BOTH `await` herdr first and
    throw `workspace_not_found` before the removal line. So the row is
    unremovable through the API, permanently, by design of the ordering.
    `listWorkspaces` then UNIONS the index with herdr's live set —
    `[...fromHerdr.keys(), ...agentsByWs.keys(), ...Object.keys(indexed)]`
    — so the dead row appears in every response with a `cwd` and no
    agents, indistinguishable from a real empty workspace. A client
    listing working sets is told about workspaces that do not exist, and
    the only surface that knows better is an endpoint nobody calls.
    **The fix is ordering, not a new verb.** `workspace_not_found` from
    herdr means the goal state ALREADY HOLDS, so it is a success for index
    purposes and the removal should still run — close becomes idempotent,
    the way `POST /v1/permissions/{id}` is idempotent in the gateway
    review's §4 for the same reason: two callers racing a teardown must
    both see the terminal state, not one success and one error. Anything
    else (reaping on a schedule, reconciling at boot) is a bigger change
    that this does not need.
    Worth separating from that bigger change, though: item 31(f) asks for
    a boot-time reconciliation pass, and this bug is NOT an argument for
    one. A row that cannot be removed by the call whose whole job is
    removing it is a defect on that path. Reconciliation would paper over
    it, and would still leave the API lying between one spawn and the next
    sweep. 31(f) stands on its own merits and is untouched by this.
    **What shipped, and the boundary that was nearly missed.** The
    existing test asserted the OLD contract in as many words — "herdr
    refusing an unknown workspace surfaces as its own error" — and a
    blanket absorb would have turned a typo'd id into a silent success
    claiming to have reaped something that never existed. So not-found is
    absorbed only when the BROKER HOLDS A ROW for that id: a row here and
    nothing at herdr is the reaped case and the row is ours to clear; an
    id neither side knows still errors. Both halves are mutation-checked
    independently — dropping the row guard fails the typo case, dropping
    the catch fails the reaped case, neither fails the other.
    `closed` is the POSTCONDITION and stays `true` on every success, since
    an idempotent delete answering false invites a retry that can never
    work; `already_closed` carries who did it. That deliberately reads
    differently from the git verbs (`{committed:false, clean:true}`),
    where false means the thing you expected does not exist.
    **The other half, done 2026-08-31 from a user bug report.** The
    paragraph that stood here said nothing removes the row if a caller
    never calls close at all, and handed that gap to 31(f). A reported
    reproduction promoted it, because the stale row is not cosmetic — it
    permanently breaks spawn. `POST .../agents {workspace_id}` takes the
    mode-B path and calls `pane.split` on a workspace herdr has destroyed,
    and the broker surfaces herdr's own `pane_not_found`: deterministic, 4
    of 4, surviving a sign-out and a broker restart because
    `workspaces.json` persists it. A client that deletes agents but never
    deletes workspaces — the natural shape for a UI that manages AGENTS —
    stranded a row on every cleanup.
    `stopAgent` now asks. After `pane.close` it probes whether herdr still
    has the workspace and, ONLY on a definite no, performs the same index
    removal and `resumable.record` archiving that `broker.workspace.close`
    performs. Clearing the workspace row while leaving the agent rows was
    rejected as the worst of the three options: a reaped workspace's pane
    ids are free for herdr to reuse, which is exactly the stale-pointer bug
    `AgentIndex.removeWorkspace` exists to prevent, and half-cleaning keeps
    that bug while reporting the workspace tidied.
    **The probe is deliberately NOT `herdrWorkspaces`.** That helper
    degrades to an EMPTY MAP when `workspace.list` fails or is absent,
    which is right for its three READERS — they fall back to the index and
    keep working — and catastrophic for a WRITER, which would read "herdr
    answered nothing" as "herdr reaped everything" and erase the index of
    every herdr that merely lacks the method (0.8.0 does), turning a
    degraded-but-working setup into total data loss. So the self-heal owns
    a three-state probe — live / reaped / no opinion — and only the middle
    state acts. Same call, two contracts, on purpose.
    The bookkeeping degrades rather than throwing: `pane.close` has already
    succeeded, so a failure here would report a stop that plainly happened
    as failed and invite a retry that can only answer `no agent in pane`.
    Same postcondition reasoning as `closed: true` above, and the same
    degrade contract as `prepareWorkspace`/`trustProject` on the spawn path.
    Three tests, mutation-checked independently: never healing fails only
    the reaped case, treating no-opinion as reaped fails only the
    degradation case, and ignoring the still-live answer fails only the
    surviving-team case.

## Agent credentials (2026-08-31, found running WT-12)

33. **A broker-spawned `claude` is not logged in, and nothing says so.**
    **"Nothing says so" fixed 2026-08-31 — spawn now refuses. The
    credential half is DEFERRED, deliberately; see the end of this item.**
    Every one of them. `prepare` redirects `CLAUDE_CONFIG_DIR` to a
    broker-owned directory so a trust dialog is answered inside the
    broker's blast radius rather than the user's global config — and that
    redirect relocates the CLI's WHOLE config tree, credentials with it.
    The pane reads `Not logged in · Please run /login`, each turn ends in
    about zero seconds, and the transcript fills with `<synthetic>`
    assistant rows carrying the CLI's own error.
    This is the same shape as the trust bug in `prepare` fixed the same
    day: a redirect written to scope ONE thing quietly took everything
    else with it. The difference is that the trust bug announced itself
    with a dialog, and this one produces an agent that looks like it is
    working. `agent.list` reports it detected and `interactive_ready`;
    `agent.prompt` succeeds; the transcript grows; the evidence tier reads
    a completed turn — correctly, because a turn DID complete. Every
    signal the broker has is green for an agent that cannot do anything.
    **What it cost before anyone noticed.** WT-12's seeding `ask` failed
    with `agent_unresponsive` / `evidence: "transcript"` — "finished its
    turn but wrote no answer file" — which is precisely accurate and reads
    like a product bug in `ask`. Chasing that exposed this, and this in
    turn exposed a FALSE POSITIVE in WT-11 (item 31's verification note):
    a probe that measured transcript bytes could not tell a copied
    conversation from a remembered one, and the logged-out agent made the
    difference invisible. Two conclusions were wrong because one
    precondition was never checked.
    Also established on the way: **`ask` has never run against a live
    agent.** It is unit-tested against `FakeHerdr` only, and WT-12 was the
    first caller ever to reach a real CLI with it.
    **The mechanism to use probably already exists** — `POST .../env` with
    `ANTHROPIC_API_KEY`, the same path that carries `COPILOT_GITHUB_TOKEN`
    into copilot spawns in the demo stack. What is missing is anything
    saying claude REQUIRES it. Open questions, none of them answered here:
    whether an API key through the env registry is the intended answer for
    a subscription-authenticated user at all; whether `prepare` should
    inherit or copy credentials out of the user's real config rather than
    orphaning them; and whether spawn should DETECT a logged-out agent and
    fail loudly instead of handing back a green pane. The last one matters
    most — a wrong answer is cheap to fix, a silently useless agent is not.
    Registered as **WT-13**. **Probe written and RUN 2026-08-31**
    (`test/wire/claude-auth.wire.ts`), against claude 2.1.252 on a live
    herdr.
    **The prose above was wrong about the wording, and that is the whole
    argument for probing.** The pane reads `Not logged in · Run /login` —
    "Run", not "Please run". A matcher written from this item's own text
    would have compiled, passed its unit tests against a fixture copied
    from the same text, and never matched a real agent. The shipped
    matcher is a verbatim observation instead, and only the unambiguous
    half of it: a bare `/login` occurs in help output and in anything a
    user types, and a false positive here FAILS a working spawn.
    Confirmed in the same run, at the same instant: `agent.list` said
    `{id, title: "claude", status: "idle"}` and the spawn returned
    `status: "idle"`. Green throughout, for an agent that cannot work.
    **What shipped.** `cli-profiles` gains `unauthenticated: {match}` —
    present ONLY for claude, absent and never probed for every other kind,
    the same discipline `prepare` follows for unverified config formats.
    Spawn reads the pane once after the settle window, which is free: the
    settle already waited, and it is the very loop returning the false
    green, so the correction belongs there rather than anywhere cheaper.
    A hit throws `agent_unauthenticated` (502) naming the marker and the
    remedy.
    **Two placement decisions carry the design.** The check sits BEFORE
    `agents.set`, so a refused spawn records no row and there is nothing to
    clean up — the same reason the settle failure sits where it does. And
    it does NOT close the pane: on a mode-A spawn that pane is the
    workspace's only one, so closing it makes herdr reap the workspace and
    the `workspace_id` handed back would be dead on arrival. Failing with
    both ids intact is spec §2.1's existing contract — set a credential
    with `POST .../env`, retry mode B into the SAME workspace. Verified
    live: the refusal carried `w5`, and `w5` was still listed afterwards.
    Degrades like its neighbours: an unreadable pane proceeds exactly as
    before, and an EMPTY read is treated as an instrument at zero rather
    than as proof of health.
    **Credential validation: DEFERRED 2026-08-31, by decision, not by
    blocker.** Nothing technical stands in the way — `POST .../env` already
    carries `COPILOT_GITHUB_TOKEN` into copilot spawns in the demo stack and
    would carry `ANTHROPIC_API_KEY` the same way today. What is missing is a
    reason to believe it is the RIGHT answer, and that is a product
    question: the affected user is subscription-authenticated, and handing
    the broker an API key bills a different account against a different
    quota. Guessing costs more than waiting.
    The refusal makes waiting safe, which is the point of taking detection
    first. Before it, a logged-out spawn was indistinguishable from a
    working one and poisoned whatever it touched — it produced WT-11's false
    positive and consumed all of WT-12 before anyone noticed. Now it is a
    502 naming its own cause, so the gap costs a clear error instead of
    silent wrong conclusions. That is what makes this a deferral rather than
    a hole.
    **What it still blocks, unchanged:** WT-11's sub-question 1 (does resume
    reattach CONTEXT?) and all of WT-12, both of which need a claude that
    can actually answer; and `ask`, which remains unproven against any live
    agent — unit-tested against FakeHerdr only.
    **Where to start when it is picked up.** claude's own `--help` says it
    reads strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` — OAuth and the
    keychain are never consulted — so `apiKeyHelper` is the branch worth
    probing first: it is a COMMAND the CLI calls, which means the broker
    could point a spawn at the user's existing credential source without
    copying a secret into a broker-owned directory at all. That would answer
    the second question (should `prepare` inherit credentials?) without the
    blast radius that copying implies. `[[env_hooks]]`, keyed by `kind`, is
    already the right shape for handing it over; what is missing is a
    builtin hook per kind, not new machinery — the same conclusion WT-5
    reached for copilot.
    Deliberately NOT done in the meantime: validating a key the broker was
    given, or probing whether one works before a spawn. Both presuppose the
    key is the answer, which is the question being deferred.
    **One hazard found on the way, and it is the probe's, not the
    broker's.** The spawned pane also read `Transcript saving is off —
    inherited CLAUDE_CODE_CHILD_SESSION marker`. That variable is set
    inside a Claude Code session; a daemon started from such a shell passes
    it to every pane, and the spawned claude then writes no transcript at
    all. Every transcript-derived measurement — WT-10's token counts,
    WT-11's reattachment question, the whole evidence tier — would be
    reading an empty file and could not tell that from an agent that
    produced nothing. Recorded in the wire README; run probes from a plain
    shell.

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

The numbered roadmap ran 29 of 29 as of 2026-08-29 — every item closed,
deferred with a stated condition, or documented, and nothing waiting on an
answer. **Items 30-33 opened it back up on 2026-08-30/31.** 31 and 32 are
built; 30 (usage and cost) is unbuilt because nobody asked, with a first
slice named in its own entry. **33's detection half landed 2026-08-31** — a broker-spawned claude is still
logged out, but the broker now refuses the spawn instead of handing back a
green pane, so it can no longer make other work draw wrong conclusions the way
it did twice. What remains of it is the credential decision, which blocks
WT-11(1) and WT-12. 31(f)'s push detection landed 2026-08-31
(`workspace.closed`); its boot-time reconciliation stays a deliberate loose
thread, and neither 31 nor 32 substituted for that half.

Publishing is not pending work: interactive OAuth is the recorded decision
(item 26), and 0.3.0 shipped that way. Of the wire questions, `codex` is
ANSWERED and off the status tier (item 27's profile, 2b8406f); `copilot`'s
schema is answered with only its completion signal open, behind a PAT service
being built elsewhere; and **two questions have no probe file at all** —
**WT-6** (herdr's `pane.exited` exit code) and **WT-10** (whether each CLI's
store records token counts, and in what shape). WT-8 and WT-9 were added
2026-08-29 and are answered. **WT-11** was registered, written and RUN on
2026-08-30: `claude` answers all of it, mode D's shape is settled on evidence
(item 31(e)), and the run found a shipped bug on the way — claude's trust
pre-answer had never applied to any directory. The other three kinds in
WT-11's row remain unprobed, and it still shares a spawn fixture with WT-10.
What else remains is the demand-driven tails recorded in the strike notes
(skins, framework adapters, federated multi-user, PDF extraction, quotas)
plus the in-flight model-discovery spikes. In flight, pending credentialed spikes: per-user
model discovery (probe-on-spawn keyed by credential context, `auto`
until a list is recorded — ACP body vs pane body undecided until the
wire truth lands).
