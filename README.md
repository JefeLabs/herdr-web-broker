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
| `WS /parent/ws` | duplex rpc + unsolicited status events |

Every herdr method is passthrough (see `herdr api schema --json`), gated by a
deny-list (`policy.remote_deny`, default: `server.stop`,
`server.reload_config`, `plugin.*` for remote-originated calls).

Remote sessions are also projected as local sockets —
`HERDR_SOCKET_PATH=~/.config/herdr/remotes/laptop/default.sock herdr agent list`
drives the laptop with the stock CLI.

## Security

- The daemon listens on `127.0.0.1` unless you explicitly configure otherwise.
- Child secrets are 256-bit, name-bound, shown once, stored hashed. Revoke with
  the **Broker: revoke child** action.
- For cross-network use, prefer a tailnet/VPN or TLS-terminating proxy; direct
  TLS via `[tls] cert/key` config is supported.

## License

MIT
