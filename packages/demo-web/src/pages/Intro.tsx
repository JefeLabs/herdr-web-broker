import { BROKER_ORIGIN } from "../components/EndpointCard";

const WIRE = String.raw`
   ┌─ laptop (child) ──────────┐        ┌─ home server (parent) ─────────────┐
   │  herdr ── panes w/ agents │        │  herdr-web-broker :7591            │
   │    │                      │  WSS   │    │                               │
   │  broker plugin ───────────┼────────┼──▶ tunnel hub                      │
   │  (dials out, NAT-safe)    │        │    │                               │
   └───────────────────────────┘        │  REST /instances/…   WS /events    │
                                        └────┼───────────────────────────────┘
                                             │ bearer token
                                   you · curl · this console
`;

export function Intro() {
  return (
    <div className="page">
      <section className="hero">
        <div className="kicker">herdr plugin · self-hosted · parent ↔ child</div>
        <h1>
          Your coding agents,
          <br />
          <em>one API away.</em>
        </h1>
        <p className="lede">
          herdr keeps Copilot, Claude Code, and friends alive in terminal panes. herdr-web-broker lifts that
          local socket onto the network — REST + WebSocket — and federates whole machines behind one parent.
          List sessions, watch which agents are blocked, spawn teams into workspaces, prompt them, and read
          their repos — from anything that can hold a token.
        </p>
        <div className="cta">
          <a className="btn" href="#/console">
            open the console
          </a>
          <a className="btn ghost" href="#/workspace">
            browse a workspace
          </a>
          <a className="btn ghost" href="#/api">
            api spec
          </a>
        </div>
      </section>

      <pre className="wire" aria-label="architecture">{WIRE}</pre>

      <section className="feature-row">
        <div className="feature">
          <h3>Federated by design</h3>
          <p>
            Children dial out and hold the tunnel, so roaming laptops stay reachable behind NAT. One parent, one
            token, every machine's sessions under /instances/&#123;instance&#125;.
          </p>
        </div>
        <div className="feature">
          <h3>Status that matters</h3>
          <p>
            working · blocked · idle — folded from herdr's own detection and streamed over WS the moment an
            agent stalls on an approval. "Blocked" is the signal this product exists for.
          </p>
        </div>
        <div className="feature">
          <h3>Workspaces & repos</h3>
          <p>
            Every working set knows its team roster and its git repos: file trees from git's own index, diffs
            against any base — never node_modules, never scraped from a terminal.
          </p>
        </div>
        <div className="feature">
          <h3>Credentials, injected</h3>
          <p>
            A write-only env registry exports tokens into the pane shell through a seconds-lived 0600 drop file
            before the agent starts. The value never transits the PTY, a log, or a GET.
          </p>
        </div>
        <div className="feature">
          <h3>Structured answers</h3>
          <p>
            Ask a TUI agent for JSON and get JSON — a file-drop handshake through the shared filesystem, with
            size caps and parse-error honesty built in.
          </p>
        </div>
        <div className="feature">
          <h3>Full passthrough</h3>
          <p>
            Every herdr socket method rides POST …/rpc, gated by a deny-list for remote calls. The stock herdr
            CLI can even drive remote sessions through projected local sockets.
          </p>
        </div>
      </section>

      <section>
        <h2 style={{ fontFamily: "var(--display)", letterSpacing: "0.08em" }}>Quickstart</h2>
        <p className="note">
          Point this site's proxy at a broker (VITE_BROKER_TARGET, default {BROKER_ORIGIN}), drop your bearer
          token into the console header, and every card on the next page is live against it.
        </p>
        <pre className="wire">{`$ curl ${BROKER_ORIGIN}/health
{"ok":true,"name":"herdr-web-broker","version":"0.1.0","pid":…}

$ curl -H "Authorization: Bearer $TOKEN" ${BROKER_ORIGIN}/instances
{"instances":[{"instance":"runtime","online":true,…}]}`}</pre>
      </section>
    </div>
  );
}
