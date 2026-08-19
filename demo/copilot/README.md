# Demo: Copilot over HTTP

One container, one endpoint: a [herdr](https://herdr.dev) server keeps a
[GitHub Copilot CLI](https://github.com/github/copilot-cli) agent alive in a
pane, and the herdr-web-broker plugin lifts herdr's local socket onto
HTTP :7591 — so a plain `curl` from outside the container creates the
workspace, launches Copilot, sends it a prompt, and reads its answer back.

Everything installs the official way: herdr via
`curl -fsSL https://herdr.dev/install.sh | sh`, Copilot CLI via
`curl -fsSL https://gh.io/copilot-install | bash`, and this plugin cloned from
GitHub and `herdr plugin link`ed — the broker daemon is even started through
the plugin's own `start` action rather than by hand.

## Run it

```sh
# full round trip (Copilot answers): needs a fine-grained PAT with the
# "Copilot Requests" permission
COPILOT_GITHUB_TOKEN=github_pat_... ./validate.sh

# without a token: validates the whole chain up to prompt fulfillment
./validate.sh
```

`validate.sh` builds the image, runs it, waits for `/health`, then drives the
entire flow over HTTP with a bearer token (`BROKER_TOKEN`, default
`demo-token`):

| step | call |
| --- | --- |
| create workspace | `rpc workspace.create {cwd, label}` |
| launch Copilot | `rpc agent.start {name: "copilot", kind: "copilot", pane_id}` |
| send the prompt | `rpc agent.prompt {target: "copilot", text}` |
| read the answer | `rpc pane.read {pane_id, source: "screen"}` |

where `rpc` is
`POST /parent/runtime/sessions/default/rpc {"method", "params"}` with
`Authorization: Bearer $BROKER_TOKEN`.

## Talk to it by hand

While the container runs:

```sh
curl -s -H "Authorization: Bearer demo-token" \
  -H 'content-type: application/json' \
  -X POST http://127.0.0.1:7591/parent/runtime/sessions/default/rpc \
  -d '{"method":"agent.prompt","params":{"target":"copilot","text":"explain this repo"}}'
```

Any herdr socket method passes through the same way — `agent.list`,
`pane.read`, `workspace.list` — subject to the broker's method deny-list.
