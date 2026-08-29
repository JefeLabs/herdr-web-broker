# The `localEndpoints` / `provisioner` seam

Two fields on `DaemonOptions` decide where the broker's sessions come from.
Together they are the point at which herdr-web-broker can serve sessions
backed by something that is not a herdr the daemon discovered for itself.

They are currently labelled `(tests, devstack)`. This document describes what
they actually are, what treating them as *supported* would commit to, and what
is still undecided.

```ts
// src/daemon.ts
export interface DaemonOptions {
  localEndpoints?: HerdrEndpoint[];
  /** session-ownership provisioner override (tests, devstack); the real
   *  exec-based one is used only when running against real herdr */
  provisioner?: SessionProvisioner;
}
```

## What each one does

**`localEndpoints` displaces discovery entirely.** It is not a hint or a
fallback — passing it turns the whole local-herdr search off:

```ts
// src/daemon.ts — the displacement, in one place
const local = new LocalHerdr({
  endpoints:     opts.localEndpoints,
  envSocket:     opts.localEndpoints ? undefined : process.env.HERDR_SOCKET_PATH,
  defaultSocket: opts.localEndpoints ? undefined : join(homedir(), ".config/herdr/herdr.sock"),
  sessionsDir:   opts.localEndpoints ? undefined : join(homedir(), ".config/herdr/sessions"),
});
```

With it set, `HERDR_SOCKET_PATH`, the default socket and the sessions
directory are all forced to `undefined`. The broker stops looking at the
machine and talks only to what it was handed.

**`provisioner` supplies sessions on demand**, for session ownership — a
caller authenticates and gets a herdr of their own:

```ts
// src/provisioner.ts
export interface SessionProvisioner {
  start(name: string): Promise<HerdrEndpoint>;
  stop(name: string): Promise<void>;
}
```

The two are wired to be mutually exclusive by construction: the real
exec-based `HerdrProvisioner` is only constructed when `localEndpoints` is
absent. Supplying endpoints means supplying every session yourself.

## Why this is a seam and not a test hook

The whole contract is two strings:

```ts
// src/local-attach.ts
export interface HerdrEndpoint {
  session: string;
  socketPath: string;
}
```

`SessionProvisioner.start()` returns an **endpoint**, not a process handle, a
child, or a PID. Nothing downstream ever learns how the session came to
exist. Everything the broker does afterwards — the tunnel, socket projection,
ownership, the registry, workspace and agent indexes, transcript resolution —
is already written against endpoints and sockets.

That is the property worth naming: **an alternative backend does not have to
impersonate a herdr binary. It has to produce something a unix socket path can
point at that speaks herdr's wire protocol.** Those are very different bars.

It is also already proven, not theoretical. `packages/demo-web/devstack.mjs`
runs the real broker against `FakeHerdr` through exactly this seam:

```js
const handle = await startDaemon({
  localEndpoints: [{ session: "default", socketPath: fake.socketPath }],
  provisioner,
  // ...
});
```

That is why the e2e suite needs no Docker and no herdr installation. The seam
carries a full Playwright suite against the real broker every CI run.

It is load-bearing well beyond the devstack. `localEndpoints` is how
`daemon.test.ts`, `ws-client.test.ts`, `federation.test.ts` and
`projection.test.ts` boot their daemons — federation and projection use it
twice each, standing up a parent AND a child from two fake herdrs. Nearly
every integration test in this repo runs through it.

Which makes the gap in commitment 2 below sharper rather than softer: the seam
is exercised constantly, and the *displacement rule* — the part a third-party
backend would depend on — is asserted nowhere. `grep -rn "HERDR_SOCKET_PATH" test/`
finds only an unrelated live-smoke reference. Every existing test passes
endpoints and never checks that doing so turned discovery off.

## The backend contract: 18 methods

This section exists because a prospective adopter pointed out, correctly, that
the repo had **no declared contract for what a backend must implement** — only
an implementation that assumes herdr and a test fake that assumes it too. They
had to reconstruct the list with a regex and hand-classify it. Nobody should
have to do that twice.

Below is the full surface, extracted from every `.request(` call site in
`src/` plus the two the attach path uses directly. A single-line grep
undercounts it, because calls wrap across lines.

### Attach and liveness — without these there is no session at all

| method | called from | what breaks without it |
| --- | --- | --- |
| `ping` | `local-attach.ts` | attach fails; the endpoint is never adopted, and the liveness probe that re-checks it has nothing to call |
| `events.subscribe` | `local-attach.ts`, `ws-server.ts` | the push channel that feeds the registry. The broker still works, but agent status only updates when a client asks with `?fresh=1` |
| `agent.list` | `http.ts`, `workspace-ops.ts`, `module-api.ts` | no roster: `GET .../agents`, the counts, and spawn-readiness checks all go blind |
| `workspace.list` | `http.ts`, `workspace-ops.ts` | workspace roster, plus the cwd half of transcript resolution — `lookupCwd` falls back to the broker's own index |

### Spawn — the four modes

| method | mode | what breaks without it |
| --- | --- | --- |
| `workspace.create` | A (fresh workspace) | mode-A spawns |
| `pane.split` | B (join existing) | mode-B spawns |
| `worktree.create` | C (isolated checkout) | mode-C spawns |
| `agent.start` | all | every spawn, on every path |
| `pane.send_input` | all | env injection AND the readiness sentinel share this one call |
| `pane.wait_for_output` | all | **degrades, does not break.** The sentinel is best-effort by design; spawn falls through to the `agent_pane_busy` retry |

### Agent operations — each gates one endpoint

| method | gates |
| --- | --- |
| `agent.prompt` | `POST .../agents/{pane}/prompt` — fire-and-forget steering |
| `agent.wait` | `POST .../agents/{pane}/wait` |
| `agent.explain` | `GET .../agents/{pane}/explain` |
| `pane.read` | the pane viewer and `GET .../panes/{pane}/screen` |
| `pane.close` | `DELETE .../agents/{pane}` — agent stop |

### Teardown and worktrees

| method | gates |
| --- | --- |
| `workspace.close` | `broker.workspace.close`, and ownership teardown |
| `worktree.list` | `GET .../worktrees` |
| `worktree.remove` | `DELETE .../worktrees/{w}` |

### What a partial backend does

A backend implementing a subset fails **per-endpoint, not globally**, which is
what makes incremental adoption viable. `FakeHerdr` answers an unregistered
method with `{ error: { code: "not_found" } }`, and the broker surfaces that as
an upstream error on the one route that needed it. Everything else keeps
working.

So the practical floor is the four attach-and-liveness methods plus whichever
feature groups you want. `ping` + `agent.list` alone — which is literally what
`FakeHerdr` implements by default, in 116 lines — is enough to attach, list a
roster, and serve the instance and session endpoints.

### Why `FakeHerdr` cannot be the contract

It is the sharpest evidence that this is a documentation gap rather than an
engineering one: 116 lines, no herdr code whatsoever, and it backs the entire
450-test suite plus the Playwright e2e. **A non-herdr backend driving the full
broker plane already exists and runs in CI on every push.**

But it enumerates almost nothing. It registers exactly two handlers by default
and every other verb is set ad-hoc per test as a lambda:

```js
t.fake.handlers.set("workspace.create", () => ({ root_pane: { pane_id: "w2:p1" } }));
```

That is the right design for a test double — each test states only what it
needs — and precisely the wrong shape for a contract. The list above is the
artifact that was missing.

## What "supported" would commit to

Today these are internal options with an internal audience. Declaring them
supported is a compatibility promise, and it is worth being explicit about
its shape rather than implying more than the project can keep.

1. **`HerdrEndpoint` and `SessionProvisioner` become public types.** Their
   shapes stop being free to change. Both are small enough that this is a
   cheap promise: two strings, and two methods.

2. **The displacement rule becomes a documented behaviour.** "Passing
   `localEndpoints` disables env, default-socket and sessions-dir discovery"
   is currently an implementation detail readable in one place. As a contract
   it must survive refactors, which means a test asserting it — there is none
   today.

3. **The `u-` namespace invariant needs restating for third parties.**
   `HerdrProvisioner.#guard()` refuses any session name outside the `u-`
   namespace, so the primary herdr hosting this plugin is untouchable *by
   construction* rather than by check. A second implementation of
   `SessionProvisioner` gets no such protection automatically. Any supported
   contract has to say plainly: **a provisioner must never return an endpoint
   for a session it does not own**, and the broker cannot enforce that for
   you.

4. **The consumer is an in-process embedder.** The broker is not published to
   npm — the root `package.json` is `private: true`, and it reaches users via
   `herdr plugin install`. So "supported" here means supported for code that
   imports `startDaemon` from `dist/`, the way `devstack.mjs` does. It does
   not mean a published API, and pretending otherwise would be the kind of
   claim this repo has had to correct before.

## The smithagents-over-broker path

`smithagents` (sibling repo) is a local-first control plane whose `swarm/`
package is an orchestrator: agents-as-data, squads, and tasks that **run CLIs
in git worktrees via tmux/docker**, behind an HTTP API on :7777.

That last part is the overlap. herdr-web-broker also runs agent CLIs, in
worktrees, over a REST/WS API — the difference is that its execution substrate
is herdr panes rather than tmux/docker invoked directly, and it already
carries the things that get expensive later: per-pane ask locking, transcript
tiers with per-CLI profiles, spawn readiness, session ownership, an audit
trail, and parent↔child federation over a child-initiated tunnel.

The seam is where those two could meet. A `SessionProvisioner` implemented
against smithagents' swarm would let the broker serve sessions that swarm
provisions, without either side learning the other's internals — swarm keeps
owning squads and task shape, the broker keeps owning the herdr wire and the
API surface.

**Not proposed here, and deliberately so.** Two independent orchestrators
converging is a decision with real cost, and nothing in this document argues
it is worth paying. What this records is narrower and more useful: *if* that
path is ever taken, this is the seam it goes through, and the seam already
works.

## Announced vs placed — a taxonomy, not a trigger

A child **dials out to tell the parent where it is**. Location is announced,
because it cannot be known in advance: the laptop roams, and
`pair --address ws://parent:7591` points the child at the one side that is
reachable. A container you started or a host you provisioned is different —
its socket is known at creation, so there is nothing to announce.

| | how the parent learns the location | mechanism |
| --- | --- | --- |
| **announced** | the child tells it, on connect | `pair`, child-initiated tunnel, `TunnelHub` |
| **placed** | already known, at creation | `localEndpoints` / `SessionProvisioner` |

Federation and this seam are therefore two halves of one problem rather than
alternatives. `HerdrEndpoint` being `{session, socketPath}` and nothing else
is why they converge: downstream of attach, the broker cannot tell which way
an endpoint arrived, and does not need to.

**This is a taxonomy — it says which mechanism a host needs. It is not a
trigger, and an earlier version of this document wrongly used it as one.**
That version defined the trigger as "true the first time a session's socket
is known before the session exists", which `HerdrProvisioner.start()` has
satisfied since 2026-08-22: it computes `socketPath` from `sessionsDir` and
the session name *before* spawning `herdr server`, then polls for the session
to catch up to the path it already chose. A condition satisfied a week before
it was written describes the status quo; it does not gate anything.

## The NAT flip — and why it does not gate this seam

The NAT flip is a real condition, recorded in the smithagents 2026-08-27
assessment and relayed here on 2026-08-29. It is **not** the taxonomy above:

- **What would have to become true:** the product must drive agents on other
  people's machines and roaming laptops, over NAT, reachable only outbound.
- **Observable or a judgement?** A product judgement, not observable. It fires
  when a requirement lands, not when a network condition changes — nothing in
  the broker could detect it. A trigger is better when observable, which is
  what made the "placed" framing attractive; this one genuinely is not, and
  saying so beats engineering a proxy for it.
- **Possible, necessary, or cheaper?** **Cheaper.** The hosted design already
  answers remote execution differently (cell-per-tenant Fargate, BYO-compute),
  so federation and cells are competing answers to one need. They collide only
  if federation would replace cells.

What gives the condition teeth is an asymmetry worth stating plainly:
herdr-web-broker's child-dials-out federation is proven across two real
containers with 13 checks and a weekly canary, while smithagents' own remote
path provably cannot run a task — the repo is never shipped to the worker and
secrets are never forwarded, both test-pinned. The flip is not "this is
nicer"; it is "there is no working answer in that direction and this one is
demonstrated".

**But that population is the ANNOUNCED one.** Roaming laptops reachable only
outbound are served by federation — `pair`, the child-initiated tunnel — not
by `localEndpoints`/`SessionProvisioner`, which by the taxonomy above is the
placed half. So the NAT flip gates adoption of the broker's **federation**. It
does not gate this seam.

## This seam is ungated

It has no trigger, and that is the honest status rather than a gap. The seam
is documented, contract-bound, needs no code change to be used, and nothing in
the product today requires it. If a reason to act arrives it will be recorded
here; inventing one in the meantime is what produced the already-satisfied
condition above.

## Status

The seam exists, is exercised by every CI run through the devstack, and needs
no code change to be used. What it lacks to be *supported* is the four
commitments above — of which only the second (a test pinning the displacement
rule) is actual work; the rest are decisions.
