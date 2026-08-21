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
- The response's `agent` is a **string** (the agent's name, used as the
  prompt target); `status` is top-level.

## 2. Readiness — first-run dialogs

Fresh CLIs often block on a trust or login dialog before accepting work.
The pane is a real PTY, so read it and answer it:

```
POST .../rpc  {"method": "pane.read",      "params": {"pane_id": "w1:p1", "source": "visible"}}
POST .../rpc  {"method": "pane.send_keys", "params": {"pane_id": "w1:p1", "keys": ["1"]}}
```

`/agents?fresh=1` reports `interactive_ready` / `launch_pending` per agent
when you need a machine signal instead of screen text.

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
  hanging the full budget. **One ask at a time per pane**: a second
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
  `raw_status` is where you see it.
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
  branchable `200 {waited: false, timed_out: true}`, not an error.
- **`GET .../agents/{pane}/explain`** — herdr's detection diagnostics
  (rules, evidence, region preview): the answer to "why does this pane
  show the wrong kind or status".
- **`pane.read`** over rpc — the same screen as a one-shot, when you
  don't need the long-poll discipline.

## 6. Death — and its current honesty gaps

Agents die when their process exits or their pane closes; herdr keeps the
pane listed, and the fold hides the difference (see `raw_status` above).
The broker's protections:

- `ask` fails fast with `agent_unresponsive` when the agent never starts
  working (default 15s grace) — no more full-budget hangs on a dead pane.
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

## Quick reference

| Phase | Endpoint |
| --- | --- |
| Start | `POST .../agents` with `kind`, `cwd` or `workspace_id`, `args?` |
| First-run dialogs | `pane.read` / `pane.send_keys` via `POST .../rpc` |
| Continue conversation | `POST .../agents/{pane}/prompt` `{text}` |
| Structured turn | `POST .../agents/{pane}/ask` `{prompt}` → `{answer}` |
| Soft steer mid-run | `POST .../agents/{pane}/prompt` (CLIs queue it) |
| Hard interrupt | `pane.send_keys ["Escape"]`, then prompt |
| CLI commands | `POST .../agents/{pane}/slash/{command}` |
| Model switch | `POST .../agents/{pane}/model` `{model}` |
| Design docs loop | `POST .../agents/{pane}/spec-bundles` + long-poll GET |
| Status | `GET .../agents?fresh=1` (`status` + `raw_status`) |
| Watch the terminal | `GET .../panes/{pane}/screen?version=&wait_ms=` (long-poll) |
| Live events | `WS /events` |
| Stop one agent | `DELETE .../agents/{pane}` (its pane closes; the team survives) |
| Reap a working set | `DELETE .../workspaces/{w}` (panes + agents die with it) |
