# Wire tests

Live probes against a real herdr. NOT part of `npm test` — they need a
running broker + herdr instance and the real CLIs installed. Run one with:

    HERDR_WIRE=1 node --test dist/test/wire/paste.wire.js

`tsconfig.json`'s `include` covers `test/**/*.ts`, so `npm run build`
compiles and type-checks every file here under `strict` right alongside the
real suite — a wire test that stops type-checking fails the build even
though it never runs. `npm test`'s glob is `dist/test/**/*.test.js`, which
`*.wire.js` doesn't match, so these build without running; the
`{ skip: !process.env.HERDR_WIRE }` guard on each test is belt-and-braces
on top of that, for anyone who points `node --test` at the whole
`dist/test` tree directly.

Each answers a question this design could not verify offline. Record the
answer in the spec's wire-truth table and, where it is a per-CLI fact, as a
`[[cli.profiles]]` row in `config.toml` — not as new reader code.

| id | question | if it fails |
| --- | --- | --- |
| WT-1 | ~~does `pane.send_input` bracket multi-line paste?~~ **ANSWERED 2026-08-29** (herdr 0.8.2) — YES. A four-line heredoc arrives as one paste; the shell shows `heredoc>` continuation prompts and echoes the body. No bug, no fix needed | — |
| WT-2 | ~~does `agy --conversation <fresh-uuid>` mint that id, or reject it?~~ **ANSWERED 2026-08-29** (herdr 0.8.2) — NEITHER, quite: agy ACCEPTS the flag (it reaches the terminal title) but mints nothing under that id within 45s, and `last_conversations.json` never learns it | agy stays on cwd-map + `startedAt` discovery — roadmap 25(d) closes as won't-fix |
| WT-3 | ~~`opencode export` output shape~~ **ANSWERED 2026-08-27** — opencode's real store is `~/.local/share/opencode/opencode.db` (SQLite+WAL); a finished assistant turn carries `time.completed`, and `session.directory` makes cwd discovery a SQL predicate | — |
| WT-4 | ~~codex `rollout-*.jsonl` terminal record shape~~ **ANSWERED 2026-08-29** (codex-cli 0.151.0, live) — rollout IS findable by cwd for a freshly spawned session via `session_meta.payload.cwd`, and a finished turn ends `event_msg` with `payload.type: "task_complete"` carrying a top-level ISO `timestamp`. Record kinds seen: `session_meta`, `event_msg/task_started`, `response_item/message`, `world_state`, `turn_context`, `event_msg/item_completed`, `event_msg/task_complete` | — codex CAN leave the status tier: `via: "path"` discovery by cwd, `terminal.done: ["task_complete"]` |
| WT-5 | copilot `session-store.db` schema — probe RUN 2026-08-29, schema ANSWERED, completion signal still open. `sessions(id, cwd, …)` gains a row per fresh cwd (cwd -> session_id discovery works) and `turns(id, session_id, turn_index, user_message, assistant_response, timestamp)` IS written — a row appears on SUBMISSION, ~65s after the prompt, with `assistant_response` NULL until the turn finishes. Every run hit `Authorization error, you may need to run /login`, so no turn ever completed and `assistant_response` going non-null is UNCONFIRMED | copilot stays on the status tier until an authenticated run confirms the completion signal |
| WT-6 | does herdr's `pane.exited` carry an exit code? | agent-death cause stays unreported (the exec endpoint is unaffected — it reads its own `; echo $?` drop file, not `pane.exited`) |
| WT-7 | ~~does `pane.wait_for_output` match the pane's OWN echoed input, or only program output?~~ **ANSWERED 2026-08-29** (herdr 0.8.2) — the pane's OWN echoed input, on `visible` AND `recent`; `matched_line` comes back as the echoed command itself | — **and this answer was then MISAPPLIED.** Roadmap 27's sentinel was built on "when it echoes, the shell is at its prompt", which this answer disproves rather than supports: it matched its own echo and reported cold panes ready. Fixed 26235cd; see the instrument note below |
| WT-8 | ~~does herdr's agent detection fire for an agent TYPED into a pane, or only one started via `agent.start`?~~ **ANSWERED 2026-08-29** — NOT bound to `agent.start`. A `claude` typed into a pane via `send_input` is detected with `agent=claude` and reaches `agent_status=idle`; sampled every 5s for 60s, the typed path and the `agent.start` control are indistinguishable from the 5s mark. Run by the smithagents session; **not independently reproduced here**, because it spawns a real agent | a command-string runtime would get no detection and would have to drive `agent.start` by kind |
| WT-9 | ~~is `keys: ["C-c"]` accepted by `pane.send_input`, and does it interrupt?~~ **ANSWERED 2026-08-29** — accepted via `{pane_id, keys}` with no `text` field, AND effective: a negative control confirmed `sleep 300` held the pane first. `Escape` is accepted through the same shape. Reproduced here independently — though it failed once first, on a cold shell that never reached a prompt inside its 15s readiness window. Not flakiness in the probe: see the load note below | a runtime sending tmux key names would need a translation layer; outcome 3 (accepted but no-op) would have been the silent one |
| WT-10 | do the CLI stores record TOKEN COUNTS, and in what shape? Four kinds have a resolvable transcript (`claude` path, `agy` map, `opencode` sqlite, `codex` scan) and only `claude` is a confident yes. Per kind: does a completed turn carry counts at all, under what field names, are the input/output/cache-creation/cache-read classes kept SEPARATE or pre-summed, and is a row a per-turn DELTA or a running session TOTAL? That last one decides whether accumulation is a sum or a max — backwards in either direction and every multi-turn session is wrong, silently and in a plausible-looking way | roadmap 30 ships `claude`-only and usage is ABSENT for every other kind — absent, never `0`, per the rule 25(c) set for `evidence` |

WT-3's answer already shipped and needs no probe: `src/cli-profiles.ts`'s
`opencode` profile (`via: "sqlite"`) and `src/transcript.ts`'s
`parseOpencode`.

WT-10 has NO PROBE FILE — it and WT-6 are the two open questions with
nothing written. It is also the heaviest spawner on this table: four kinds,
each needing a real completed turn, which is precisely the shape the
contamination note below warns about. Run it one kind per run, and read a
slow trial as load before reading it as an answer.

## A probe is an instrument, not a test

WT-1 and WT-2 were both first run on 2026-08-29 and both failed — neither for
its stated reason, and each would have entered the table above as a false
finding.

`paste.wire.ts` read `screen.text`, but `pane.read` answers
`{ type, read: { text } }` — the text is NESTED. The envelope's `.text` is
`undefined`, which coerced to `""`, so every assertion failed as though the
pane were empty and the failure message accused `send_input` of a transport
bug it does not have. Recorded, that would have sent someone rewriting the
send path to fix working code.

`agy-pin.wire.ts` spawned into a fresh `mkdtemp`, which is exactly what makes
agy show its first-run "Do you trust the contents of this project?" gate. The
agent never became active, and the probe died `agent_not_ready` before
reaching its own question — it could not answer WT-2 even in principle.

The tell in both cases was in the assertion output: `actual: ''` is not
"wrong content", it is "no content" — an instrument reading zero rather than
taking a measurement. When a probe goes red, rule out the probe before
recording anything about herdr.

A probe can also answer CORRECTLY and have its answer misapplied, which is
the same failure one step later. WT-7 asked whether `pane.wait_for_output`
matches the pane's own echoed input; the answer is yes, it is recorded
correctly above, and roadmap 27's spawn-readiness sentinel was built by
reading that yes as confirmation of its design — "when it echoes, the shell is
provably at its prompt". It is not. An echo proves the PTY accepted bytes,
which a cold pane does perfectly well; only OUTPUT proves a shell executed
anything. The shipped sentinel therefore matched its own echo and reported
cold panes ready, and the 3ms it appeared to take should have been read as
impossible rather than as headroom. Fixed 2026-08-29 by shaping the marker so
it cannot appear in its own command. When a probe's answer is used to justify
a design, check that the answer supports the CLAIM and not merely the
sentence.

The rule is not confined to this directory. `test/backend-contract.test.ts`
extracts the herdr method surface from `src/`, and its first version scanned
400 characters forward from each `.request(` and took the first dotted string
literal — which attributes a decoy to any of the five call sites that pass the
method as a variable, in a tree containing `herdr.sock`, `audit.log`,
`git.read` and `auth.self_kick`. It was clean by luck of surrounding text, not
by construction, and the failure it was one edit away from is the familiar
one: a red test confidently instructing someone to document a method that does
not exist. Found by the smithagents session reviewing this repo, fixed in
64ecb45 — only an immediate literal counts now, so a dynamic site contributes
nothing rather than noise. Any test that DERIVES a fact rather than asserting
one is an instrument, and gets read with the same suspicion.

Both are fixed, and `paste.wire.ts` now arms WT-7's sentinel before sending,
so it no longer races the cold-shell window roadmap 27 exists to close.
Once a question is ANSWERED its probe's assertion is inverted to pin the
answer, so it passes as a regression guard and goes red only if the behavior
CHANGES — see WT-2.

WT-4 and WT-5 were written the same day. WT-4 is now answered; WT-5 ran but
could not reach its question. Their DISCOVERY halves were
smoke-tested against the stores already on disk — `findRolloutForCwd` locates
a real rollout by its recorded cwd and returns undefined for an unused one;
the copilot `cwd -> session_id` query resolves and its negative control comes
back empty — so the machinery that defeated WT-1 and WT-2 is already ruled
out. What remains unverified is the half only a spawn can reach: what a
FRESHLY created session writes. Do not record either answer until they run.

## A probe that spawns agents contaminates its own later trials

Cold-shell readiness is a measurement of the MACHINE as much as of the code,
and a probe run that spawns real agents degrades the conditions for everything
after it.

Measured 2026-08-29, same code and same call ordering, minutes apart: with
eight `claude` processes alive from earlier probe spawns and load average
~3.0, cold shells failed to reach a prompt within TWENTY seconds, three
consecutive trials. As the load cleared, three consecutive trials succeeded in
~525-630ms. Arm-first versus send-first was tested explicitly and made no
difference; the variable was the box.

Two things follow. `DEFAULT_TIMEOUT_MS = 5000` in `src/spawn-readiness.ts` is
tight enough that ordinary load defeats it — the gate then degrades to false
and the `agent_pane_busy` retry carries the spawn, which is the designed
floor, so nothing breaks; but the gate contributes nothing exactly when panes
are slowest, which is when it would help most. Whether 5000 is the right
number needs usage data nobody has yet, so it is recorded as a measurement and
not a recommendation.

The second is the one that costs time. Both sessions working on this
independently read a load-induced timeout as "the fix does not work", because
it contradicted a clean run minutes earlier. Before concluding anything from a
slow or timing-out probe, check what else is running — very possibly your own
earlier spawns.

## WT-5's remaining step: stop driving the TUI

`/login` was done on 2026-08-29 and did NOT close this. The auth error is
gone; the probe still cannot drive a turn to completion, and the reason has
been a different screen every attempt.

The gate ORDER is not stable. It was restore-then-trust in one run and
trust-then-restore in the next, so handling each once in a fixed sequence
clears one and walks into the other — where the probe's own prompt text
becomes a menu selection. The probe now loops, handling whichever gate is on
screen and re-checking readiness each pass, which is strictly better and still
did not produce a completed turn.

The schema half stays answered. What is unconfirmed is only the completion
SIGNAL: `assistant_response` going non-null.

Two gates stand in front of copilot, and BOTH defaults are wrong for a probe.
It opens on a "Restore interrupted sessions" picker where `enter` RESTORES a
previous session — which is what defeated the first runs: copilot then
legitimately ran in an EARLIER probe's folder, so the pane showed that folder
(read at the time as a stale buffer, which it was not) and no turn was written
for the cwd under test. `esc` starts fresh. Behind it sits the directory-trust
prompt. The probe now handles both explicitly, in that order.

That is the same hazard as the codex update menu one screen earlier, and the
same rule applies: a probe must never send input into a screen it has not
positively identified, because in a menu a prompt is a SELECTION.

**The way through is to stop driving the TUI at all — DEFERRED 2026-08-29,
pending a PAT service already in progress.** copilot can start from a PAT, and
the broker already has the seam for handing one to a spawn: `[[env_hooks]]` in
config.toml runs a command per `kind` and `EnvRegistry.resolveForSpawn` injects
the result, with only the drop-file PATH crossing the PTY. The hook's `command`
is what calls that service. A pre-authenticated copilot should not present
login-shaped gates at all, which turns this probe from one that fights a
terminal into one that reads a store.

So WT-5 is not blocked on anything in this repo. Retry it once the service can
mint a copilot PAT; until then the schema answer stands and copilot stays on
the status tier. Do NOT spend more attempts driving the gates — four rounds of
correct fixes each revealed another screen, which is the signal that the
instrument is the wrong KIND of instrument, not that it needs a fifth fix.

The three CLIs each want something different, from their own `--help`: claude
is "strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain are never
read)", codex takes `--remote-auth-token-env <ENV_VAR>` — the NAME of a
variable rather than a value — and copilot documents only `login`, so its PAT
route is an env var it does not advertise. `env_hooks` being keyed by `kind`
is the right shape for that spread; what is missing is a builtin hook per
kind, not new machinery.
