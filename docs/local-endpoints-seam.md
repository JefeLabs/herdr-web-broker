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

## The trigger — UNDEFINED, and needs the maintainer

The condition that would make this path worth building is referred to as the
**"NAT flip condition"**. It is not defined anywhere in this repo, and not in
smithagents either — `grep -ri "flip"` across both returns only a tunnel test
and a probe script.

It is deliberately left blank rather than guessed at. Today's model is stated
in the README: children dial out, "all over one child-initiated tunnel that
works behind NAT", and roadmap item 26 calls client unreachability "the single
largest adoption barrier". A "flip" could plausibly mean inbound reachability
becoming normal, or the assumption inverting so that agent hosts need remote
provisioning rather than dialling out — but a roadmap item gated on an
invented trigger is worse than no roadmap item, and this project has spent
real time this year correcting confident text that nobody had checked.

**To finish this section, the maintainer needs to supply:**

- What specific thing would have to become true for the flip to have fired.
- Whether it is observable (something the broker or an operator could detect)
  or a judgement call.
- What it changes: does the flip make this path *possible*, *necessary*, or
  merely *cheaper*?

Until then the seam is documented and the trigger is not, which is the honest
split.

## Status

The seam exists, is exercised by every CI run through the devstack, and needs
no code change to be used. What it lacks to be *supported* is the four
commitments above — of which only the second (a test pinning the displacement
rule) is actual work; the rest are decisions.
