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
| WT-7 | ~~does `pane.wait_for_output` match the pane's OWN echoed input, or only program output?~~ **ANSWERED 2026-08-29** (herdr 0.8.2) — the pane's OWN echoed input, on `visible` AND `recent`; `matched_line` comes back as the echoed command itself. The inference from `source:`'s vocabulary was right | — the spawn-readiness sentinel is viable; roadmap 27 is unblocked |

WT-3's answer already shipped and needs no probe: `src/cli-profiles.ts`'s
`opencode` profile (`via: "sqlite"`) and `src/transcript.ts`'s
`parseOpencode`.

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

## WT-5's remaining step: `copilot` then `/login`

Run `copilot` once by hand and `/login`. Every probe run on 2026-08-29 reached
copilot in the right cwd and submitted the prompt — the pane shows
`❯ say hello` above the correct folder — and every one came back
`Authorization error, you may need to run /login`. So `assistant_response`
stayed NULL for a reason that has nothing to do with the schema, and the
completion signal is the one thing still unconfirmed.

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
