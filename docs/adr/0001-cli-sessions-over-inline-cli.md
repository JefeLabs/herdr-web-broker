# ADR 0001 — Agents run in herdr CLI sessions, not as inline CLI subprocesses

**Status:** Accepted
**Date:** 2026-08-19
**Deciders:** Edwin Cruz (with design discussion recorded in the
workspace & repos API brainstorm)

## Context

The broker needs coding agents (Copilot, Claude Code, Codex, …) it can
observe, prompt, and manage over its HTTP/WS API. There are two ways to
run an agent CLI:

1. **CLI session** — the agent runs inside a herdr pane: a PTY owned by
   the herdr server, addressable over herdr's socket protocol
   (`agent.start`, `agent.prompt`, `pane.read`, `pane.send_keys`,
   status events).
2. **Inline CLI** — the broker (or any caller) executes the agent binary
   directly as a subprocess, typically in a headless/one-shot mode
   (`-p … --json`-style), reading stdout.

The choice is really between two *shapes* of work. Session-shaped:
long-running, interactive, supervised, multi-agent. Pipeline-shaped:
one-shot, headless, structured output, exit. This product — status
rollups, blocked-agent surfacing, remote prompting, human takeover —
is entirely the first shape.

## Decision

**The broker builds exclusively on herdr CLI sessions.** Every agent the
broker manages lives in a herdr pane; the broker never execs agent
binaries inline.

What sessions buy, concretely:

- **Survival.** A pane is owned by the herdr server, not the caller. The
  broker restarts, HTTP clients disconnect, SSH drops — the agent keeps
  working. Inline, the agent dies with its parent or requires bespoke
  daemonization and supervision.
- **Interactivity.** Agent CLIs are interactive TUIs: trust dialogs,
  permission prompts, pickers. A real PTY plus `pane.read`/`send_keys`
  makes those workable remotely (the demo answers Copilot's trust dialog
  with `send_keys ["1"]`). Inline headless modes typically mean
  auto-approve-everything — surrendering the safety property the broker
  exists to surface.
- **Status detection.** herdr classifies `idle|working|blocked|done` and
  streams change events. "Blocked" — an agent waiting on a human — is
  the product's most valuable signal. Inline, we would regex-parse every
  CLI's output, per tool, per version, forever.
- **Human takeover.** A pane is attachable like tmux: when the API can't
  handle something, a person opens the same terminal, intervenes, and
  hands back. An inline subprocess has no joinable view.
- **A roster.** Sessions → workspaces → panes give stable ids,
  `agent.list`, and lifecycle events — the management plane the team
  model (workspace = a team agent's set of repos) is built on.
- **Agent-agnostic protocol.** `agent.start {kind}` / `agent.prompt` /
  `pane.read` don't change when a second agent brand is added.

What inline would have bought — lower latency and native structured
output for one-shot jobs — serves pipeline-shaped work the broker does
not do.

## Consequences

**Positive**
- Remote approvals, blocked-state surfacing, and mid-task human takeover
  are possible at all; they have no inline equivalent.
- Workspaces persist across broker restarts, so the repos/tree/diff API
  and the WorkspaceIndex stay meaningful between prompts.
- Adding a new agent kind is configuration, not an adapter.

**Negative / accepted costs**
- **Structured output needs a bridge.** A TUI pane's output is a rendered
  screen, not JSON. Pipeline-shaped requests against session-shaped
  agents are served by the file-drop handshake (`broker.agent.ask`:
  prompt contract → agent writes `.herdr/answers/<id>.json` → broker
  collects), so payloads never transit the terminal renderer. Screen
  scraping (`pane.read` + sentinels) is deliberately NOT used for data.
- **Hard dependency on herdr** and its socket protocol (verified against
  0.8.0; see docs/herdr-0.8-protocol-notes.md). Protocol drift is
  absorbed in `local-attach.ts` and mirrored by `fake-herdr` tests.
- One-shot batch invocations, if ever needed, would be a new, separate
  facility (a headless sidecar running in the workspace cwd) — kept out
  of scope until a use case that doesn't need session context actually
  appears.

## Revisit when

- An agent CLI ships a first-class daemon/API mode that provides
  survival + status + interactivity without a PTY, or
- a genuine pipeline workload (no session context needed) shows up —
  build the sidecar then, alongside sessions, not instead of them.
