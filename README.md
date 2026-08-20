# herdr-web-broker

A [herdr](https://herdr.dev) plugin that lifts herdr's local socket API onto
the network — REST + WebSocket — and federates instances parent↔child. Enroll
your laptop with the herdr running on your home server; from the server (or
anything holding a token) list the laptop's sessions, check which agents are
blocked, and send prompts — all over one child-initiated tunnel that works
behind NAT.

## How it compares

- **herdr-remote** — phone/menu-bar monitoring via a hosted tunnel. This plugin
  is self-hosted: your parent, your secret, no third-party relay.
- **herdr-mirror** — drives remote servers over SSH. This plugin needs no SSH
  reachability: children dial out, so roaming laptops stay connected.
- **herdr-mobile-relay** — phone approvals. This plugin is an API, not an app:
  full method passthrough for any client, plus socket projection for the herdr
  CLI itself.

## Install

`herdr plugin install` from the marketplace, or clone this repo and
`herdr plugin link` it. The build compiles TypeScript; the startup hook keeps
the broker daemon alive.

## Pair a child

On the parent: run the **Broker: issue child secret** action
(`issue-secret --name laptop`) — copy the printed secret.
On the child: run **Broker: pair with parent**
(`pair --address ws://parent-host:7591 --secret <secret> --name laptop`).

The child dials out and holds the tunnel; the parent can now reach it.

## API

Bearer-token auth (`[[client_tokens]]` in config.toml). Instance `runtime` is
the local machine; anything else is an enrolled child.

| Route | Meaning |
| --- | --- |
| `GET /parent` | all instances with live status rollup |
| `GET /parent/{instance}` | one instance: online, versions, sessions |
| `GET /parent/{instance}/sessions` | herdr sessions on that machine |
| `GET /parent/{instance}/sessions/{s}/agents` | agents + status (`?fresh=1` re-queries) |
| `POST /parent/{instance}/sessions/{s}/rpc` | any herdr socket method: `{"method", "params"}` |
| `POST /parent/{instance}/sessions/{s}/agents` | spawn a team agent: `{kind, cwd|workspace_id, label?, name?, args?}` — `workspace_id` creates a NEW workspace sharing that cwd (herdr 0.8.0 has no verified pane-create); unused workspaces are not auto-reaped yet |
| `GET /parent/{instance}/sessions/{s}/workspaces` | working sets: team roster + discovered repos per workspace |
| `GET .../workspaces/{w}/repos/{r}/tree` | repo file tree (`{r}` = repo path; `-` = workspace root) |
| `GET .../workspaces/{w}/repos/{r}/git/diff?base=REF` | branch, status, unified diff |
| `GET .../workspaces/{w}/repos/{r}/file?path=` | raw file contents (768KB cap, containment-guarded, `.git` refused) |
| `POST .../repos/{r}/git/commit` | stage + commit: `{message, add_all?, author?}` — clean tree answers `{committed:false, clean:true}` |
| `GET .../repos/{r}/git/log?limit=` | recent commits: `{sha, subject, author, when}` |
| `POST .../repos/{r}/git/push` | push (default origin/current branch); failures carry git stderr |
| `POST .../repos/{r}/git/checkout` | switch or create a branch: `{ref, create?}` |
| `PUT .../workspaces/{w}/context/{name}` | upload a context attachment (raw body, 8MB cap) — stored in `.herdr/context/`, never part of the repos; active files are auto-listed in every prompt/ask/spec text |
| `GET .../workspaces/{w}/context[/{name}]` | list attachments / download one |
| `POST .../workspaces/{w}/context/{name}` | toggle `{active}` — drop a file from prompts without deleting it |
| `DELETE .../workspaces/{w}/context/{name}` | remove an attachment |
| `POST .../agents/{pane}/ask` | structured JSON answer from a TUI agent (file-drop) |
| `POST .../agents/{pane}/prompt` | fire-and-forget steering: `{text}` to the same agent — spawn once, keep prompting the pane |
| `POST .../agents/{pane}/model` | switch a running agent's model: `{model}` typed as the CLI's own `/model` command |
| `POST .../agents/{pane}/slash/{command}` | type any CLI slash command into the pane (`/clear`, `/instructions`…); optional single-line `{args}` |
| `POST .../agents/{pane}/spec-bundles` | create/continue a spec bundle (a dir of design files) and prompt the agent to draft into it: `{name\|bundle, prompt, file?}` — `file` focuses the page being viewed |
| `POST .../agents/{pane}/spec-bundles/{b}/plan` | ask the agent to distill the bundle into `plan.md` |
| `GET .../workspaces/{w}/spec-bundles` | list bundles + member files |
| `GET .../workspaces/{w}/spec-bundles/{b}?version=&wait_ms=` | pull all member files with a combined version; long-poll returns the moment the agent saves |
| `GET /parent/{instance}/models?kind=` | model catalog per CLI kind with attributes (context window etc) — builtin defaults + `[[models.catalog]]` config overrides |
| `POST /parent/{instance}/env` | store an env var for agent spawns: `{name, value, kind?, session?}` — write-only |
| `GET /parent/{instance}/env` | stored names + scopes + source (`manual`/`hook`) — never values |
| `DELETE /parent/{instance}/env/{name}` | remove an entry (`?kind=&session=` select the scope) |
| `DELETE /admin/tokens/{name}` | revoke a client token: immediate for new requests/WS upgrades, persisted to config.toml (admin-gated) |
| `WS /parent/ws` | duplex rpc + unsolicited status events |

How these fit together across an agent's life — spawn, first-run dialogs,
conversation, mid-run steering, observation, death — is walked through in
[docs/agent-lifecycle.md](docs/agent-lifecycle.md).

Every herdr method is passthrough (see `herdr api schema --json`), gated by a
deny-list (`policy.remote_deny`, default: `server.stop`,
`server.reload_config`, `plugin.*` for remote-originated calls).

Agents needing credentials get them at spawn: values POSTed to `/env` (or
fetched by config-declared `[[env_hooks]]` commands — manual values win) are
exported into the pane shell through a seconds-lived 0600 drop file before
`agent.start`, so the CLI starts authenticated and the value never transits
the PTY or any log.

Workspace/repo routes are served by the broker itself (`broker.*` virtual
methods) and on child instances require the child's plugin at or above this
version — an older child forwards them to herdr, which answers
unknown-method.

How herdr 0.8.0 actually behaves on the wire — one-shot rpc connections,
subscribe-only event channels, per-pane status subscriptions, real frame
shapes — is written up in
[docs/herdr-0.8-protocol-notes.md](docs/superpowers/specs/herdr-0.8-protocol-notes.md).

Remote sessions are also projected as local sockets —
`HERDR_SOCKET_PATH=~/.config/herdr/remotes/laptop/default.sock herdr agent list`
drives the laptop with the stock CLI.

## Client SDK

[packages/client](packages/client) is `@jefelabs/herdr-broker-client` — a
zero-dependency TypeScript SDK (browser + Node ≥ 20) exposing the API as
handles: `broker.instance().session().spawn()` → `agent.prompt/ask/slash/
setModel/interrupt`, repo reads, spec-bundle `follow()` long-polling, and a
WS event channel with subprotocol auth and reconnect. The demo site's
workspace browser, auth gate, and events panel are built on it.

## Demo site

[packages/demo-web](packages/demo-web) is a React site that exercises every endpoint above,
live: an interactive console (one card per route + a WS events panel), a
workspace/repo file browser, and an API reference with a downloadable
OpenAPI 3.1 document. Run the full real stack in Docker
(`docker build -f packages/demo-web/Dockerfile -t herdr-web-demo . && docker run --rm
-p 5173:5173 -p 7591:7591 herdr-web-demo`) or herdr-free via its dev stack —
see [packages/demo-web/README.md](packages/demo-web/README.md).

## Security

- The daemon listens on `127.0.0.1` unless you explicitly configure otherwise.
- Child secrets are 256-bit, name-bound, shown once, stored hashed. Revoke with
  the **Broker: revoke child** action.
- For cross-network use, prefer a tailnet/VPN or TLS-terminating proxy; direct
  TLS via `[tls] cert/key` config is supported.

## License

MIT
