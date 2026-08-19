# herdr 0.8.0 socket protocol — field notes

What the herdr 0.8.0 binary actually does on its socket, where that differed
from this broker's original assumptions, and how the broker adapted. Compiled
from two independent investigations (raw wire captures against a live 0.8.0
server, and containerized probes built for the `demo/copilot` image) that
converged on the same findings. Everything below is verified behavior, not
documentation-derived.

The broker's adaptation lives almost entirely in `src/local-attach.ts`
(`oneShotRpc`, `SessionEvents`, `mapAgentList`, `mapHerdrEvent`) and in
`test/fake-herdr.ts`, which mirrors these semantics so the suite exercises
the real protocol.

## The four core differences

| # | Original broker assumption | herdr 0.8.0 actual behavior |
| --- | --- | --- |
| 1 | `events.subscribe` takes `{subscriptions: [{type}]}` | A `pane.agent_status_changed` subscription **requires `pane_id`**; a missing field is an `invalid_request` and herdr closes the socket |
| 2 | Subscribe + rpc share one long-lived connection | **RPC sockets are one-shot** (herdr closes after a single response, exactly how its own CLI behaves); a subscription socket is **subscribe-only** and is reset if an rpc is sent on it |
| 3 | `agent.list` returns `{agents: [{id, title, status}]}` | Returns `{type: "agent_list", agents: [{agent, agent_status, pane_id, workspace_id, terminal_title, terminal_title_stripped, name?, launch_pending, interactive_ready, ...}]}` |
| 4 | Status events are `{event: {type: "pane.agent_status_changed", agent: {...}}}` | Events are `{event: "<name>", data: {agent, agent_status, pane_id, workspace_id}}` |

Consequence of #1 before the fix: the broker's global subscribe was rejected,
herdr closed the socket, and the broker's close handler retired the session —
sessions appeared once and immediately disappeared. #2 meant any subsequent
rpc on the same connection would have reset it anyway; #3/#4 meant data that
did arrive mapped to empty ids/titles and an always-`idle` status.

## Evidence (raw wire captures)

Socket: `~/.config/herdr/herdr.sock`, NDJSON frames.

**A. A global (pane-less) status subscribe is rejected and the socket closes:**

```
-> {"id":"s1","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.agent_status_changed"}]}}
<- {"id":"","error":{"code":"invalid_request","message":"invalid request: missing field `pane_id` at line 1 column 105"}}
   CLOSED after ~100 ms
```

**B. A per-pane subscribe is accepted and the socket stays open:**

```
-> {"id":"s1","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.agent_status_changed","pane_id":"w2:p1"}]}}
<- {"id":"s1","result":{"type":"subscription_started"}}
   (connection remains open, streaming events)
```

**C. Multiple subscriptions must be sent in a SINGLE `events.subscribe` call.**
A second `events.subscribe` on an already-subscribed connection resets it:

```
-> events.subscribe(pane w2:p1)   <- subscription_started
-> events.subscribe(pane w1:p1)   (second call, same connection)
   ECONNRESET
```

But one call carrying an array of subscriptions works:

```
-> {"id":"s1","method":"events.subscribe","params":{"subscriptions":[
     {"type":"pane.agent_status_changed","pane_id":"w1:p1"},
     {"type":"pane.agent_status_changed","pane_id":"w2:p1"}]}}
<- {"id":"s1","result":{"type":"subscription_started"}}
```

**D. Real streamed status-change event shape** — note the DOTTED event name:

```
<- {"event":"pane.agent_status_changed","data":{"agent":"copilot","agent_status":"working","pane_id":"w2:p1","workspace_id":"w2"}}
<- {"event":"pane.agent_status_changed","data":{"agent":"copilot","agent_status":"done","pane_id":"w2:p1","workspace_id":"w2"}}
```

Lifecycle events observed on the same channel arrive with UNDERSCORED names
(`pane_created`, `pane_agent_detected`, `workspace_created`) and richer
payloads. The broker normalizes `.` → `_` before matching so both spellings
land.

**E. RPC sockets are one-shot** — herdr closes the connection after one
response; a second request on that same connection never gets a reply:

```
-> {"id":"a1","method":"agent.list","params":{}}
<- {"id":"a1","result":{"type":"agent_list","agents":[{"agent":"copilot","agent_status":"done","pane_id":"w2:p1","workspace_id":"w2",...}]}}
   CLOSED
```

Sending an rpc on a subscription connection resets it, so subscribe and rpc
cannot share a connection.

## Additional verified behaviors

- **Status vocabulary is five-valued:** `idle | working | blocked | done |
  unknown` (schema `AgentStatus`). The broker's three-bucket counts fold
  `done` and `unknown` into `idle`.
- **`agent.start` params:** `{name, kind, pane_id}` required (plus optional
  `args`, `timeout_ms` in (3000, 300000]); the pane must already exist
  (`workspace.create` returns `root_pane.pane_id`, format `w1:p1`).
- **`agent.prompt` params:** `{target, text, wait?}` — target is the agent's
  NAME (an inactive/launching agent answers `agent_not_ready`).
- **`pane.read` params:** require `source` ∈ `visible | recent |
  recent_unwrapped | detection`; the text is at `result.read.text`.
- **`pane.send_keys` params:** `keys` is a SEQUENCE (`{"keys": ["1"]}`), not
  a string.
- **`ping`** answers `{type: "pong", version, protocol, capabilities}` —
  protocol 19 on 0.8.0 — and is the cheapest liveness probe.
- **Plugin config dir** is deterministic:
  `~/.config/herdr/plugins/config/<plugin-id>`, surfaced to plugin processes
  as `HERDR_PLUGIN_CONFIG_DIR`.
- **Discover it all yourself:** `herdr api schema --json` dumps the complete
  JSON Schema (top-level `schemas.{request, success_response, error_response,
  event, subscription_event}`, with per-method variants under
  `schemas.request.oneOf`).

## Design consequences in this broker

1. **`oneShotRpc()`** — one connection per request, matching herdr's own CLI.
2. **`SessionEvents`** — a dedicated subscribe-only channel per session,
   carrying lifecycle subs (no `pane_id` needed) plus one
   `pane.agent_status_changed` sub per known pane, all in a single
   `events.subscribe`. When the pane set changes, the channel is torn down
   and reopened with the updated list.
3. **Presence is owned by rpc, not the stream.** A session is created and
   retired by one-shot probes (`ping` / `agent.list`); losing the event
   channel merely degrades to refresh-on-rescan until the next successful
   re-subscribe. `GET .../agents?fresh=1` and `POST .../rpc` keep working
   even with the event stream down.
4. **`mapAgentList`/`mapHerdrEvent`** read the real fields: id is the stable
   `pane_id`; title prefers `terminal_title_stripped`, then `name`/`agent` —
   and both functions coerce status through the same five-to-three fold, so
   `applyAgentStatus` (matching on id) lines up with what `mapAgentList`
   registered.

## Workspace & repos API verification (2026-08-19)

Spec §8 calls for confirming three open questions against `herdr api schema
--json` from inside the `demo/copilot` container (see
`demo/copilot/validate.sh`'s `herdr api schema --json | jq ...` step). In
this execution environment `docker info` never returns — the daemon is
unreachable (not merely absent: the CLI resolves and hangs indefinitely
rather than erroring), even with the sandbox restriction lifted — so the
container could not be built or run and the schema dump could not be taken.

**verification pending — fallbacks in effect.**

The three questions it would have answered, still open:

1. Does herdr 0.8.0 expose a `workspace.list` method, and if so, does its
   response carry a `cwd` per workspace? `herdrWorkspaces()` in
   `src/workspace-ops.ts` already calls it opportunistically as the spec §4
   primary source, but swallows any failure (unknown method, no `cwd` on the
   entries) and falls back silently to the broker's own `WorkspaceIndex` +
   an `agent.list`-derived roster. Confirming the method exists and carries
   `cwd` would let that fallback path be trusted with confidence — or, if it
   doesn't, confirm the `WorkspaceIndex` fallback is load-bearing rather
   than incidental.
2. Does herdr 0.8.0 expose any native pane-create method? `spawn()` in
   `src/workspace-ops.ts` currently answers `workspace_id`-targeted spawns
   (spec §8.2, "grow the team") by calling `workspace.create` again with the
   same `cwd` — i.e. opening a **new** workspace that happens to share the
   original's directory — rather than adding a pane to the existing
   workspace, because no verified pane-create method was available.
3. What are `agent.prompt`'s `wait` semantics — does `wait: true` block
   until the agent finishes responding, or only until the prompt is
   accepted/queued? Neither current call site passes `wait`: the `rpc`
   passthrough sends whatever the caller supplies, and `broker.agent.ask`
   (`ask()` in `src/workspace-ops.ts`) calls `agent.prompt` with bare
   `{target, text}` and then polls a file-drop plus the pane's status
   itself rather than relying on the call to block. Confirming `wait`'s
   semantics could let `ask()` block on the rpc instead of polling.

If a future run of `validate.sh` against a live container turns up an answer
that contradicts one of these fallbacks (e.g. a real pane-create method
exists, or `workspace.list` already carries `cwd` natively), that is
follow-up work against the affected task's module — not a silent patch to
this plan.
