# herdr-web-broker demo site

A React + Vite site that exercises **every endpoint the broker exposes**, live
— nothing is mocked. Four pages:

- **Intro** (`#/`) — what the broker is and how the pieces connect.
- **Console** (`#/console`) — one interactive card per REST endpoint (happy
  paths *and* error envelopes), plus a live `WS /parent/ws` panel with duplex
  rpc frames and unsolicited agent-status events.
- **Workspace** (`#/workspace`) — a dedicated file-browsing demo: pick a
  working set, see its team roster and its n git repos, browse each repo's
  tree, and read colored diffs against any base ref.
- **API Spec** (`#/api`) — reference docs generated from the same endpoint
  catalog that renders the console (so they cannot drift), plus a
  downloadable **OpenAPI 3.1** document for Swagger UI / Postman / Insomnia.

## Run it in Docker (real herdr, real usage)

From the repo root:

```sh
docker build -f packages/demo-web/Dockerfile -t herdr-web-demo .
docker run --rm -p 5173:5173 -p 7591:7591 herdr-web-demo
```

- site → http://localhost:5173 — click **get a demo token** on the auth gate
  for a self-serve login (dev-only: the site server forwards the admin token
  to `POST /admin/tokens`; browsers never see the admin secret), or use the
  configured bearer `demo-token`
- broker → http://localhost:7591 for curl/Postman against the same instance
- the container logs print the admin token for the Admin cards

## Run it locally without herdr (dev stack)

The dev stack boots the **real broker daemon** against a scripted herdr
simulator plus a seeded two-repo workspace — full endpoint coverage in
seconds, no herdr install:

```sh
npm run build          # repo root — compiles dist/
cd packages/demo-web
npm install
npm run devstack       # broker on :7591 (prints bearer + admin token)
npm run dev            # site on :5173, proxying to the broker
```

## How the site reaches the broker

All traffic rides the Vite dev/preview proxy (`vite.config.ts`) so the
browser stays same-origin — the broker sets no CORS headers — and `/admin`
routes see a loopback peer, which they require. The browser's WebSocket API
cannot set an `Authorization` header, so the proxy lifts the console's
`?token=` query param into the bearer header at upgrade time. Point the proxy
elsewhere with `VITE_BROKER_TARGET=http://host:7591`.

## Tests

```sh
npm test        # vitest: api client, endpoint catalog, OpenAPI generator
npm run build   # tsc + vite build
```

The endpoint catalog (`src/api/catalog.ts`) is the single source of truth:
the console cards, the spec page, and the OpenAPI document are all derived
from it.
