# The lifecycle of an agent

How a coding agent is born, directed, observed, and dies through the
herdr-web-broker API. Every stage below is an HTTP call against
`/instances/{instance}/sessions/{session}` (bearer auth; `runtime` is the local
machine) — the pane id returned at birth is the handle for everything after.

```
spawn ──► ready ──► converse ◄──► steer ──► observe ──► (die)
  │          │          │            │          │
  POST       pane.read  prompt/ask   prompt     GET /agents
  /agents    send_keys  spec-bundles Escape     WS /events
```

## 1. Birth — spawn

```
POST .../agents
{"kind": "copilot", "cwd": "/work", "label": "backend team",
 "args": ["--model", "gpt-5"]}
→ 201 {"workspace_id": "w1", "pane_id": "w1:p1", "agent": "copilot", "status": "idle"}
```

- `kind` is the CLI to run; `args` go verbatim to the CLI (model/effort
  flags live there — the broker never interprets them).
- **`pane_id` is the conversation handle.** Save it; the agent's full
  context lives in that pane for as long as the pane does.
- Exactly one of `cwd` (mode A: a new working set) or `workspace_id`
  (mode B: grow the team — the broker splits a new pane **into** that
  workspace via herdr's `pane.split`, wire-verified).
- **Mode C — parallel agents on branches**: add `worktree: {branch,
  base?}` with `cwd` and the broker branches the repo into an isolated
  worktree checkout (herdr `worktree.create`) and runs the agent there.
  Spawn N branches, let the agents race, merge the winner; clean up with
  `DELETE .../worktrees/{w}` — the checkout dies, the branch survives.
- Credentials stored in the env registry (`POST /instances/{i}/env`, scoped by
  `kind`) reach the pane shell before the CLI starts: natively via
  `pane.split`'s env map on mode B, via a seconds-lived 0600 drop file on
  mode A.
- On a cold pane whose login shell is still booting, the broker retries
  `agent.start` internally (`agent_pane_busy`) — spawn is reliable without
  client retries.
- **Fresh `cwd` with no repo yet?** Include *git init* in the first
  prompt — scaffolding is the agent's job, and the git surface (diff,
  commit, push, worktrees) activates on its own the moment a repo
  exists (`unborn` branches are handled). There is deliberately no init
  endpoint: the API's git verbs are the *human's* oversight loop —
  things you must be able to do without trusting the agent — while
  provisioning belongs to the agent you already have in the pane. Same
  for remotes: `git remote add` (and its credentials) is the
  agent-side deployment's business; the broker only pushes.
- The response's `agent` is a **string** (the agent's name, used as the
  prompt target); `status` is top-level.

## 2. Readiness — first-run dialogs

Fresh CLIs often block on a trust or login dialog before accepting work.
For a CLI whose profile declares a `prepare` block (`claude`, as of this
writing) the broker answers this **before launch**: it materializes a
broker-owned config dir (0700, with a 0600 pre-accepted-trust file inside)
under its own state dir and points the CLI at it through an env var
(`CLAUDE_CONFIG_DIR`) injected into the pane's shell alongside the rest of
spawn's env. The user's real `~/.claude.json` is never opened, and the
dialog never reaches the screen — scoping acceptance to the broker's own
spawns keeps the blast radius off the user's other, non-broker runs of the
same CLI.

CLIs with no such config-dir env var (every kind besides `claude`, until
their formats are verified) still need the manual path — the pane is a
real PTY, so read it and answer it:

```
POST .../rpc  {"method": "pane.read",      "params": {"pane_id": "w1:p1", "source": "visible"}}
POST .../rpc  {"method": "pane.send_keys", "params": {"pane_id": "w1:p1", "keys": ["1"]}}
```

`/agents?fresh=1` reports `interactive_ready` / `launch_pending` per agent
when you need a machine signal instead of screen text. Spawn itself treats
`interactive_ready` as a **level to hold**, not an edge to catch once: it
resamples `agent.list` across a settle window (per-profile `settleMs`,
2500ms by default) after the agent starts, and a CLI that renders its TUI
and then dies within that window fails the spawn outright (`upstream_error`)
instead of handing back the pane id of an agent that's already dead. A
herdr that never reports `interactive_ready` at all is unaffected — spawn
proceeds exactly as it did before this check existed.

## 3. Conversation — the same agent, turn after turn

Two channels, same pane, same context:

- **`POST .../agents/{pane}/prompt`** `{"text": "…"}` — fire-and-forget
  steering. Returns `{"status": "prompted"}` immediately; no reply
  contract. This is the sequential-conversation workhorse: spawn once,
  keep prompting.
- **`POST .../agents/{pane}/ask`** `{"prompt": "…", "timeout_ms": …}` —
  when the turn needs a structured reply. The broker instructs the agent
  to write `{"answer": <payload>}` to a drop file, unwraps the envelope,
  and returns `{"answer": …}` deterministically. An agent that never
  starts working fails fast as `agent_unresponsive` (504) instead of
  hanging the full budget — and for `claude`/`agy`/`opencode` (§5a)
  that error's details carry `"evidence": "transcript"` when the CLI's
  own session file is what proved it, with a message saying the agent
  finished its turn but wrote no answer file, rather than the generic
  "never started working". **One ask at a time per pane**: a second
  concurrent ask answers `409 pane_busy` (two contracts would interleave
  at the agent); steering the pane with `prompt` during an ask remains
  allowed — that's the mid-run redirection feature, not a conflict.

**When to use which — `prompt` directs, `ask` queries.** Use `prompt` when
the deliverable is the agent's *work* (file edits, tests run, a spec
drafted): it returns instantly, never blocks, and keeps the conversation
clean — observe the results through the diff endpoint, WS events, or
`pane.read`. Use `ask` when the deliverable is *data returned to the
caller* ("list the failing tests as JSON") — the right shape for
dashboards, pipelines, and any downstream consumer.

| Aspect | `prompt` | `ask` |
| --- | --- | --- |
| Blocks the HTTP call | no (ms) | yes, up to `timeout_ms` |
| Reply | none | `{"answer": <JSON>}` |
| Conversation hygiene | clean — your text only | answer-file contract rides along in the prompt |
| Failure modes | delivery errors only | `agent_unresponsive`, `upstream_timeout`, `parse_error` |

A common pattern on one pane: several `prompt` turns to do the work, then
a single `ask` to extract a structured summary of what happened.

For design work there's a purpose-built loop — **spec bundles**
(`POST .../agents/{pane}/spec-bundles` to drive, `GET
.../workspaces/{w}/spec-bundles/{b}?version=&wait_ms=` to stream the files
live): the agent maintains a directory of design documents, asks its
questions inside the file you're viewing, and each re-drive continues the
same drafting session.

## 4. Steering mid-processing

While the agent is `working` you have two levels of intervention:

**Soft steer — just send the prompt.** `POST .../agents/{pane}/prompt`
mid-run lands the text in the CLI's input; modern agent CLIs treat it as a
steering interjection (Claude Code queues it for the model's next step;
Copilot enqueues it into the prompt box):

```
POST .../agents/w1:p1/prompt  {"text": "stop using cookies — JWT"}
```

**Hard interrupt — cancel the turn, then redirect.** When the agent should
abandon its current work rather than fold your note into it:

```
POST .../rpc  {"method": "pane.send_keys", "params": {"pane_id": "w1:p1", "keys": ["Escape"]}}
POST .../agents/w1:p1/prompt  {"text": "scrap that — different approach: …"}
```

`Escape` is the portable interrupt (Claude Code cancels; most TUIs close or
stop). The broker guarantees delivery into the pane; mid-run semantics are
each CLI's own — check the effect with `pane.read` or the event stream.

**CLI controls** ride the same pane:

- `POST .../agents/{pane}/slash/{command}` — any of the CLI's slash
  commands (`/clear`, `/instructions`, `/help` …), optional single-line
  `{"args"}`.
- `POST .../agents/{pane}/model` `{"model": "gpt-5"}` — model switch,
  validated against `GET /instances/{i}/models` (builtin catalog +
  `[[models.catalog]]` config overrides).

Both return `"sent"` semantics — the TUI gives no machine ack, so
`pane.read` is the confirmation channel. Commands that open modal panels
(`/help`, `/instructions`) swallow subsequent input until dismissed:
send `Escape` first.

## 5. Observation

- **`GET .../agents`** (`?fresh=1` re-queries herdr): each agent carries
  `status` — herdr's five states folded to `working | blocked | idle` for
  counts — plus `raw_status`, the unfolded truth. **`unknown` and `done`
  fold to `idle`**, so a dead-but-listed agent looks idle in `status`;
  `raw_status` is where you see it. This listing is status-tier only —
  it does not consult a CLI's own transcript, so the fold applies exactly
  as written here regardless of `kind`. `ask` and `wait` are the two
  endpoints with transcript-tier evidence; see §5a.
- **`WS /events`** — unsolicited `agent_status` events the moment an
  agent changes state (`blocked` = waiting on a human, the signal this
  product exists for). Auth: `Authorization` header, `Sec-WebSocket-Protocol:
  bearer, <token>` (browser-friendly, preferred), or `?token=` (fallback —
  scrub the param from proxy logs). The server pings every 30s so
  intermediaries don't cull idle sockets.
- **Event passthrough on the same socket** — send
  `{id, instance, session, method: "broker.events.subscribe", params:
  {subscriptions: [{type: "pane.created"}, {type: "pane.output_matched",
  pane_id, match}, …]}}` and the broker taps that instance's herdr with a
  dedicated event channel; matching events push back as
  `{event: {type: "herdr_event", sub_id, instance, session, name, data}}`
  frames — including from enrolled children, whose events ride the
  federation tunnel. All 27 herdr subscription types work (workspace/
  worktree/tab/pane lifecycle, `layout.updated`, parameterized
  `pane.output_matched` / `pane.agent_status_changed` /
  `pane.scroll_changed`). The stream is live-only (no replay);
  `broker.events.unsubscribe {sub_id}` stops one group, socket close stops
  all, and a dead tap or disconnected child pushes
  `{event: {type: "sub_closed", sub_id, reason}}` instead of going silent.
  Caps: 8 groups per socket, 32 types per group. The SDK's
  `events.subscribe(target, onEvent, onClose)` wraps this and
  re-subscribes itself after a reconnect.
- **`GET .../panes/{pane}/screen?source=&version=&wait_ms=`** — the live
  pane viewer: the terminal text plus a content-version hash. Pass the
  last `version` with `wait_ms` (max 30s) to long-poll — the reply
  arrives the moment the screen changes, or `{unchanged: true}` at the
  deadline, so an idle pane costs one waiting request. `source=recent`
  reads scrollback (tail-truncated at 256K chars). The SDK's
  `watchScreen()` manages the loop; the demo's Pane page renders it.
- **`POST .../agents/{pane}/wait`** — the pipeline primitive: block until
  the agent transitions into a target status (`until`, default
  `idle|blocked|done` — "needs me or finished") or until the screen
  matches (`match` + `match_type: substring|regex`). Timeout is a
  branchable `200 {waited: false, timed_out: true}`, not an error. A
  status wait replies `{waited: true, status, raw_status, evidence,
  pane_id}` — `evidence` is `"transcript"` when the CLI's own session
  file (§5a) is what settled `status`, `"status"` when herdr's
  `agent_status` did. An output-match wait replies `{waited: true,
  matched_line, pane_id}` and carries no `evidence` — that path never
  touches a transcript.

  **Caveat:** herdr resolves `until` against its own `agent_status`
  first; the broker checks the transcript only after herdr's wait
  returns, and — on the transcript tier — that check can outvote the
  status herdr just resolved on. A `wait` can therefore come back with a
  `status` that does not satisfy the `until` you asked for: e.g.
  `until: ["idle"]` resolves because herdr saw the agent go idle, but by
  the time the broker reads the transcript it already shows a fresh,
  unanswered `tool_use` — so the reply reports `blocked`. That is the
  tier's actual design (transcript evidence about *this* wait always
  wins over a status snapshot), not a bug — but it does mean `until`
  is a hint to herdr, not a guarantee about the value you get back.
- **`GET .../agents/{pane}/explain`** — herdr's detection diagnostics
  (rules, evidence, region preview): the answer to "why does this pane
  show the wrong kind or status".
- **`pane.read`** over rpc — the same screen as a one-shot, when you
  don't need the long-poll discipline.

## 5a. Evidence — proof vs inference

herdr's `agent_status` is a screen-inference: it reads the pane's rendered
output and guesses. For three CLIs — `claude`, `agy`, `opencode` — the
broker instead reads the CLI's **own session transcript**: the file (or,
for `opencode`, SQLite row) the CLI itself writes as it works. A terminal
record the CLI wrote is proof of what happened; a screen guess is not.

`evidence` on a reply says which one decided: `"transcript"` means a
session-file record about *this* turn settled it; `"status"` means herdr's
`agent_status` did — either because the kind has no transcript reader
(`codex`, `copilot` — see the [wire-test table](../test/wire/README.md)
for why) or because no fresh-enough transcript record existed yet.

The practical honesty gain: on the transcript tier, a dead agent is
observable. A live agent keeps writing to its transcript as it works; a
dead one stops and never emits a terminal stop record. Because
`decideTurn` treats "no fresh record" as no evidence (falling back to the
status tier) rather than as proof of anything, and because `ask`'s and
`wait`'s status-tier fallback still folds `done`/`unknown` to `idle`
exactly as `GET .../agents` does, a `claude`/`agy`/`opencode` agent that
dies mid-turn is now distinguishable from one that's merely idle — the
transcript simply stops advancing while the status tier alone could not
tell the two apart. `codex` and `copilot` get none of this: they remain
exactly as honest (and exactly as blind to a dead-but-listed pane) as
before this feature existed, and `evidence: "status"` on every one of
their replies is how a caller knows to expect that.

## 5b. Ownership — whose herdr is it?

With session ownership enabled, `POST /auth` with an email provisions the
caller's OWN herdr (`herdr server --session u-…`, sticky binding, other
tokens get 409) and the response's `session` is where their spawns
belong. The verbs then split honestly: **detach** (kick, disconnect,
`DELETE /auth`) ends the token but the herdr and its agents keep
working; **teardown** (`DELETE .../sessions/{s}` as owner, or the admin
kill `DELETE /admin/owners/{email}`, which also invalidates the token)
closes every workspace and stops the herdr. Owned sessions are invisible
to other bearers — 404, indistinguishable from nonexistent. The primary
herdr hosting this plugin refuses teardown always.

## 5c. Modules — operator-added endpoints

An operator can add endpoints and event handlers to a running broker by
declaring a module in `config.toml`:

```toml
[[modules]]
path = "./modules/blame.js"
capabilities = ["git.read"]
```

It serves at `GET /v1/modules/blame/...`, authenticated by the broker
before dispatch — a module cannot opt out of auth, and never sees the
token itself, only its name.

**Modules are plain `.js`.** The broker `import()`s the path and owns no
compile step. Authors wanting types write TypeScript and build, or
annotate with JSDoc against `@jefelabs/herdr-broker-module`.

**Capabilities are declared, then granted.** A module has no *type* —
"git module" is a description the broker cannot verify. Instead it
declares what it intends to reach, the operator lists what it may reach,
and the broker builds the `api` object from the intersection. An
ungranted capability is `undefined` on that object, not a stub that
throws:

| capability | grants |
| --- | --- |
| `git.read` | `raw`, `diff`, `log`, `tree` — `raw` takes an argv **array** and is **read-only** |
| `git.write` | `commit`, `push` — audited |
| `files` | `read`, `write`, `list`, every path resolved against the workspace |
| `workspaces` | `list`, `cwd` — read-only |
| `agents` | `list`, `prompt`, `ask` |
| `rpc` | herdr passthrough, still subject to `remote_deny` |
| `events` | `api.on` — consume only |

Each capability wraps a helper that already carries the broker's
guarantees, so a module inherits them without knowing they exist:
`api.git` runs through `git-exec`'s no-shell `execFile` with its timeout
and repo-path guard, and `api.files` through the same `realpathSync`
escape check `ask` and `exec` use.

`api.git.raw` is read-only by allowlist rather than denylist. A denylist
over git's surface cannot be complete — and `git -c alias.x='!sh …' x` is
arbitrary shell execution, so `argv[0]` must be a bare subcommand rather
than a global option. Mutations go through the audited verbs.

**`api.agents.ask` takes the same per-pane lock core does.** A module and
a core route contending on one pane means the second gets `pane_busy`;
two concurrent asks would interleave two answer-file contracts at one
agent.

Handlers can subscribe to `broker.*` events the broker knows and herdr
cannot — `broker.agent.spawned`, `broker.agent.spawn_failed`,
`broker.ask.completed`, `broker.ask.unresponsive` (which carries
`evidence`, §5a), `broker.repo.pushed`, `broker.exec.finished`. Delivery
is at-most-once and fire-and-forget, matching `WS /events`, which is
live-only with no replay. There is no `api.emit`: module-to-module
eventing would make the ABI a message bus.

**Two properties stated plainly.**

Modules are installable **only** from `config.toml`. There is no API to
add one, and `GET /admin/modules` is observability only. A module is
arbitrary in-process code, so a bearer token that could install one would
be a remote shell.

Modules are **not sandboxed**. They run in the daemon's process with its
privileges, and `node:fs` is one import away. Capabilities make the safe
path the narrow path; they are not a confinement. Installing a module is
installing code, with the same trust as an npm dependency.

Modules load **once, at boot**. `config.toml` keeps hot-reloading
`client_tokens`, but `[[modules]]` is exempt — re-importing mid-flight
leaks whatever the old instance closed over. A change needs a restart;
`GET /admin/modules` reports the loaded set, so drift between the file
and the process is visible. A module that fails to load leaves its routes
404 and the broker still boots.

## 6. Death — and its remaining honesty gaps

Agents die when their process exits or their pane closes; herdr keeps the
pane listed, and the status-tier fold hides the difference (see
`raw_status` above). For `claude`/`agy`/`opencode`, §5a's transcript tier
closes most of that gap: those CLIs stop writing the moment they die and
never emit a terminal stop record, so `ask` and `wait` can now tell a dead
agent from an idle one instead of both looking like `idle`. `codex` and
`copilot` have no transcript reader (WT-4, WT-5 in the [wire-test
table](../test/wire/README.md) are still open), so they keep exactly the
honesty gap this section originally described — a dead `codex`/`copilot`
agent still looks `idle`, and `evidence: "status"` on every reply for
those kinds says so.

What the transcript tier does NOT give you, for any kind: **why** an agent
died. It proves an agent stopped advancing; it does not carry an exit code
or a cause — that would need herdr's own `pane.exited` event to carry one,
which is unverified (WT-6). The broker's protections against the gap that
remains:

- `ask` fails fast with `agent_unresponsive` when the agent never starts
  working (default 15s grace) — no more full-budget hangs on a dead pane.
  On the transcript tier this also fires when the transcript proves the
  turn finished but no answer file ever appeared (see §3).
- `prompt`/`ask`/`slash`/`model` all 400 with `no agent in pane` when
  herdr no longer lists an agent there.

Cleanup and remaining limitations:

- **Workspace reaping**: `DELETE .../workspaces/{w}` closes a workspace
  and every pane in it (herdr `workspace.close`, wire-verified) — agents
  inside die with their panes. Mode-B spawns no longer create extra
  workspaces at all, so there is far less to reap.
- **Agent stop**: `DELETE .../agents/{pane}` closes the agent's pane
  (herdr `pane.close`, wire-verified) — the process dies with its PTY,
  the workspace and the rest of the team survive. Restart = stop + spawn
  into the same workspace (mode B).
- **Orphans**: `GET .../sessions/{s}/orphans` reports live workspaces
  herdr knows about that this broker instance has no record of (someone
  else's spawn, or this process's own restart having dropped its index).
  It only reports — nothing here closes anything. Session teardown
  (§5b) is the one place an unrecognized workspace does get closed, and
  even there only because the whole herdr process is being stopped
  regardless; its response's informational `unrecognized: string[]`
  lists which of the closed workspaces the broker hadn't indexed.

## Quick reference

| Phase | Endpoint |
| --- | --- |
| Start | `POST .../agents` with `kind`, `cwd` or `workspace_id`, `args?` |
| First-run dialogs | pre-answered before launch (kinds with a `prepare` profile); else `pane.read` / `pane.send_keys` via `POST .../rpc` |
| Continue conversation | `POST .../agents/{pane}/prompt` `{text}` |
| Structured turn | `POST .../agents/{pane}/ask` `{prompt}` → `{answer}` |
| Run a command, get its exit code | `POST .../panes/{pane}/exec` `{command}` → `{pane_id, exit_code, ok}` |
| Soft steer mid-run | `POST .../agents/{pane}/prompt` (CLIs queue it) |
| Hard interrupt | `pane.send_keys ["Escape"]`, then prompt |
| CLI commands | `POST .../agents/{pane}/slash/{command}` |
| Model switch | `POST .../agents/{pane}/model` `{model}` |
| Design docs loop | `POST .../agents/{pane}/spec-bundles` + long-poll GET |
| Status | `GET .../agents?fresh=1` (`status` + `raw_status`) |
| Wait for a status/output | `POST .../agents/{pane}/wait` (`until` or `match`) → `evidence` on status waits |
| Watch the terminal | `GET .../panes/{pane}/screen?version=&wait_ms=` (long-poll) |
| Live events | `WS /events` |
| Operator-added endpoints | `GET /v1/modules/{id}/…`; declare in `config.toml`, inspect with `GET /admin/modules` |
| Live workspaces the broker doesn't own | `GET .../sessions/{s}/orphans` (reports; never kills) |
| Stop one agent | `DELETE .../agents/{pane}` (its pane closes; the team survives) |
| Reap a working set | `DELETE .../workspaces/{w}` (panes + agents die with it) |
