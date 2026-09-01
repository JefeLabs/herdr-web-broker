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
| WT-11 | ~~does each CLI RESUME a conversation by id from a cold start, and with what syntax?~~ **ANSWERED for `claude` 2026-08-30** (2.1.251, herdr 0.8.2), in three parts. **(1) REOPENED 2026-08-31, then ANSWERED the same day: YES, it reattaches.** The first "yes" was a false positive — the probe searched the post-resume BYTES for the token, and `--fork-session` COPIES the parent conversation into the new record, so that search succeeds whether or not the model ever spoke; a fork made by an agent that was **not logged in**, from a prompt that never mentioned the token, still contained it on two copied lines with all three assistant rows `<synthetic>`. The real answer was then measured against an AUTHENTICATED claude (2.1.252) by `claude-context-recall.wire.ts`, which drives the CLI through herdr directly rather than through the broker (whose `prepare` redirect leaves claude logged out — WT-13). Seed: the model replied `ACK` in a `claude-opus-5` row. Resume with `--resume <seed> --fork-session --session-id <fork>`: the prior conversation is visibly restored, 44842 tokens of context. Recall prompt, never naming the token: the model answered with it, in a **non-`<synthetic>` assistant row in the FORK record timestamped after the prompt went in** — the one shape a copied line cannot produce. Run green twice, on independent tokens. (2) It FORKS rather than appends — the original record is byte-identical afterwards (14430 -> 14430) and a new one appears whose first assistant row carries `parentUuid` back into the original. (3) The pin collision is REAL: `--resume` plus the `--session-id` the broker appends is rejected outright — `--session-id can only be used with --continue or --resume if --fork-session is also specified` — and **`agent.start` still returns SUCCESS**, because herdr only TYPES the command; the CLI rejects the argv and exits to the shell. A spawn that "succeeded" and an agent that never existed are indistinguishable from the broker's side. (4) The fork lands under the id the BROKER minted — the pin uuid and the new record's name matched exactly — so `AgentMeta.sessionId` still points at the live record after a resume, with nothing to re-capture | mode D is now verified end to end AS A CLI BEHAVIOUR: its shape rests on (2), (3) and (4), and (1) now confirms the thing that actually matters to a user — the resumed agent has the earlier conversation. What is still unproven is the BROKER's own path to it (WT-12), which needs an authenticated broker spawn and so waits on roadmap 33's deferred half. The other three kinds are still unprobed |

WT-3's answer already shipped and needs no probe: `src/cli-profiles.ts`'s
`opencode` profile (`via: "sqlite"`) and `src/transcript.ts`'s
`parseOpencode`.
| WT-12 | does the BROKER's mode D reattach, end to end? WT-11 answered the CLI question by passing `args` straight through; this drives roadmap 31's OWN machinery — archive the id when the pane dies, surface it on `/resumable`, resolve it back to a kind and a directory, assemble an argv that keeps the pin. Three things it must establish: the conversation IS archived when its pane closes; resuming by id with NO cwd lands in the conversation's own directory (the CLI keys transcripts on the path, so anywhere else reattaches nothing); and the resumed agent produces a token it was given before the pane died. API-level throughout — it reads nothing off disk and uses `ask`, so there is no screen to misread and no config dir to resolve | roadmap 31 stays unverified end to end: the unit tests prove the argv, only this proves the conversation came back |
| WT-13 | ~~how is a broker-spawned claude supposed to AUTHENTICATE?~~ **PROBE RUN 2026-08-31 (`claude-auth.wire.ts`), the DETECTION half answered; the auth half still open.** Observed on 2.1.252: the pane reads `Not logged in · Run /login` — **"Run", not "Please run"**, which is the wording this item's prose carried and which a matcher written from that prose would never have matched. At the same instant `agent.list` reported `{id, title:"claude", status:"idle"}` and the spawn returned `status:"idle"`: green throughout. Spawn now REFUSES such an agent (`502 agent_unauthenticated`), keeping the workspace so a credentialed mode-B retry can use it — verified live end to end. The auth half is **DEFERRED 2026-08-31 by decision** (roadmap 33): `POST .../env` would carry `ANTHROPIC_API_KEY` today, but the affected user is subscription-authenticated and an API key bills a different account — a product question, not a probe. The refusal is what makes waiting safe. When picked up, probe `apiKeyHelper` first: claude reads strictly that or `ANTHROPIC_API_KEY`, and being a COMMAND it can point at an existing credential source instead of copying a secret into a broker-owned dir | original: how is a broker-spawned claude supposed to AUTHENTICATE? Found 2026-08-31: it is not. `prepare` redirects `CLAUDE_CONFIG_DIR` to a broker-owned dir, and that relocates the whole config tree — credentials included — so every spawned claude reports `Not logged in · Please run /login` and finishes each turn in ~0s writing `<synthetic>` assistant rows. The env registry (`POST .../env` with `ANTHROPIC_API_KEY`) is the mechanism the broker ships, but nothing states claude REQUIRES it, and the redirect silently orphans an already-authenticated user. Open: whether an API key through /env is the intended answer, whether `prepare` should copy or inherit credentials, and what a spawn should do when it can detect the agent is logged out | WT-11(1) and WT-12 both stay unanswerable, `ask` stays unproven against any live agent, and every broker-spawned claude is a no-op that looks like a working one |

WT-6 and WT-10 have NO PROBE FILE (WT-13 and WT-11's sub-question 1 both gained one 2026-08-31). **WT-12's is written and RAN on
2026-08-31, but could not reach its question**: the seeding `ask` returned
`agent_unresponsive` with `evidence: "transcript"` — the agent finished a
turn and wrote no answer file, because it was not logged in (WT-13). That run
was not wasted: it is what exposed WT-13 and, through it, the false positive
in WT-11. It also means **`ask` has never been proven against a live
agent** — it is unit-tested against the fake herdr only, and WT-12 is the
first thing that ever called it for real.
WT-12's
(`resume-mode-d.wire.ts`) — it needs a broker daemon and an authenticated
claude, and it spawns two agents. Its refusal half is a separate test that
needs neither and runs in milliseconds, so a broken deployment shows up
before the expensive half, the same split WT-11 uses for discovery.
WT-11's is written and RUN for `claude` only
(`claude-resume.wire.ts`) — the one kind with a verified pin AND a `prepare`
block, so no trust gate stands in front of it, and a `via: "path"` transcript
that makes "same record vs new record" observable rather than inferred. The
other three kinds in that row still need their own.

    HERDR_WIRE=1 HERDR_TOKEN=… node --test dist/test/wire/claude-resume.wire.js

That probe needs `HERDR_PLUGIN_STATE_DIR` to match the running daemon's.
claude's transcripts do NOT live under `~/.claude` when the broker spawned
them — the profile's `prepare` block redirects `CLAUDE_CONFIG_DIR` to a
broker-owned dir under the state dir, and that redirect moves projects/ with
it. Reading the wrong tree returns an empty record set, which is an
instrument reading zero, not an answer; the probe's discovery half is a
separate test precisely so that failure is caught before two spawns.

WT-10 and WT-11 are the heaviest spawners on this table — four kinds each,
every one needing a real completed turn — which is the shape the
contamination note below warns about. Run them one kind per run, and read a
slow trial as load before reading it as an answer. They also share a
fixture: WT-11 must reach a completed turn before it can resume one, and
that same turn is what WT-10 needs to read counts off, so running WT-11
first and having WT-10 read the transcript it leaves behind costs one spawn
instead of two.

## What WT-11 found on the way to its own question

The first run never reached WT-11. It died at a claude trust dialog, which
should have been impossible: `cli-profiles.ts`'s claude profile has a
`prepare` block whose whole job is pre-answering it.

The block was working. `CLAUDE_CONFIG_DIR` was applied — claude wrote its own
`machineID`, `userID`, `firstStartVersion` and migration flags into the
broker-owned dir, so it was demonstrably reading from there. The pre-answer
was simply written where nothing reads it: `hasTrustDialogAccepted` sat at the
TOP level of `.claude.json`, and claude records trust PER PROJECT PATH, under
`projects[<cwd>]`. A real `~/.claude.json` carries no top-level copy at all.

So the flag had never answered anything, for any directory, since the block
was written. Mode C is where that bites hardest — an isolated checkout is a
new path by construction, so every worktree spawn met the dialog — and the
highlighted default is `No, exit`, which is why the probe's refusal to press
Enter on an unrecognised screen mattered more than usual.

`test/prepare-workspace.test.ts` asserted `cfg.hasTrustDialogAccepted === true`
and passed the whole time. It proved the broker WROTE the key, never that the
CLI READ it — the same shape as an instrument reading zero and calling it a
measurement. The test now asserts the structure claude actually consults, and
a second bug fell out with it: the write was a wholesale rewrite, so every
spawn reset both the CLI's accumulated state and any trust entries earlier
spawns had added. Per-directory entries cannot accumulate under a clobber.

A third finding came out of tearing the stack down rather than running it.
The probe's cleanup swallowed every failure with `.catch(() => undefined)`,
and it had been failing on all four runs: closing a workspace's only agent
makes herdr reap the workspace, so the probe's `DELETE .../workspaces/{w}`
answers `workspace_not_found` — and the broker's index row survives that
error permanently, because both sites that remove index rows call herdr
first and throw before reaching the removal. herdr's own `workspace.list`
said `[w1]`; the broker's said five. `GET .../orphans` named the difference
exactly, having been asked for the first time. Roadmap 32.

A cleanup `catch` that returns `undefined` is the same instrument problem as
a test asserting the write instead of the effect: it makes a leak the broker
could already see look like a clean teardown. The probe logs cleanup
failures now, without throwing — a cleanup that throws would mask the
result it runs after.

Two smaller instrument lessons from the same probe. `agent.start` returning
success says only that herdr TYPED the command — an argv the CLI rejects
still looks like a successful spawn, and this was misread once in exactly
that direction. And herdr's agent `title` is SCREEN-DERIVED: it carried the
full argv in the run where the CLI exited and left it in the scrollback, and
was empty in both runs where the CLI started and its TUI took over the pane.
It is not a source of truth for how an agent was launched; the broker's own
`agents.json` is, and only while the agent is alive.

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

## Running a probe from inside a Claude Code session poisons the spawns

WT-13's pane carried a second line nobody was looking for:

    ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker

That is the PROBE's environment, not the broker's doing. `CLAUDE_CODE_CHILD_SESSION`
is set inside a Claude Code session; a broker daemon started from such a shell
inherits it, the spawned pane inherits it from the daemon, and the spawned
claude then writes NO transcript at all.

It matters beyond one stray warning, because the broker's entire evidence tier
reads transcripts. A probe run this way measures a claude that cannot leave
evidence, and `readTurnState` finding nothing is indistinguishable from an
agent that produced nothing — an instrument reading zero, the failure this
directory keeps rediscovering. WT-10 (token counts) and WT-11's sub-question 1
(does resume reattach context?) are both transcript-derived and would be
measuring an empty file.

Start the daemon from a plain shell, or unset the marker, before trusting any
transcript-derived reading.

## Readiness for a RESUMED agent is not readiness for a fresh one

Two facts, both measured 2026-08-31 on herdr 0.8.2 while answering WT-11(1),
both of which defeated a first attempt.

**`interactive_ready` is ABSENT for an agent typed into a pane.** `agent.list`
reports `{agent: "claude", agent_status: "idle"}` and simply omits the key —
absent, not `false` — while a fully rendered, authenticated claude sits on
screen. A probe waiting on that field never proceeds. This refines WT-8, which
found the typed and `agent.start` paths indistinguishable for detection and
status: on this field they differ. (The broker is unaffected — its settle loop
already treats `undefined` samples as "this herdr omits the field" and only an
explicit `false` fails a spawn.)

**Detection fires long before a resumed session is usable.** A fresh claude has
nothing to replay, so detection is a fair gate. A RESUMED one reads the parent
record first, and herdr reports it detected ~5s in, while the replay is still
running. A recall prompt sent into that window is swallowed: the first WT-11(1)
run timed out with no fork record written at all, because no message ever
landed. The gate that works is a positive identification of the restored
conversation on screen — the seed's own content, visible — before typing.

Related, and worth knowing before reading an empty directory as an answer: the
fork record `<forkId>.jsonl` is not created when the resumed process starts. It
appears only once a message is sent. "No file" therefore means "no turn
happened", not "resume failed".

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
takes `ANTHROPIC_API_KEY` or `apiKeyHelper`, codex takes
`--remote-auth-token-env <ENV_VAR>` — the NAME of a variable rather than a
value — and copilot documents only `login`, so its PAT route is an env var it
does not advertise.

**Correction 2026-08-31.** This paragraph used to quote claude as "strictly
ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain are never read)" as
though it described claude generally. It does not. Read in full, that sentence
sits inside the `--bare` flag's description and is a property of **`--bare`
mode only**; ordinary claude does read the keychain, and a `Claude Code-
credentials` item is present there on this machine. The clipped version was
load-bearing in two places — it made an API key look like the only possible
answer for claude, and it made the config-dir redirect look like a sufficient
explanation for a logged-out spawn. Neither follows. Quote a `--help` line with
enough of its context to show what it is scoped to. `env_hooks` being keyed by `kind`
is the right shape for that spread; what is missing is a builtin hook per
kind, not new machinery.
