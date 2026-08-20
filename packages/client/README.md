# @jefelabs/herdr-broker-client

The sharable interaction model for herdr-web-broker: a framework-agnostic
TypeScript SDK that owns the mechanics every client otherwise re-implements —
auth verification, typed error envelopes, the ask `{"answer"}` contract,
spec-bundle long-poll loops, and WS auth/reconnect. Zero runtime
dependencies; browser and Node ≥ 20 (native `fetch`/`WebSocket`).

```ts
import { BrokerClient } from "@jefelabs/herdr-broker-client";

const broker = new BrokerClient({ origin: "http://127.0.0.1:7591", token: "demo-token" });
if (!(await broker.verify()).ok) throw new Error("bad token");

const session = broker.instance("runtime").session("default");

// start a conversation — the pane id is the handle, context lives in the pane
const agent = await session.spawn({ kind: "copilot", cwd: "/work" });
await agent.prompt("draft the login flow");            // fire-and-forget steering
await agent.prompt("actually, use OAuth");             // mid-run steer
const { answer } = await agent.ask("summarize as JSON"); // structured turn
await agent.interrupt();                               // Escape into the pane
await agent.slash("clear");
await agent.setModel("gpt-5");

// repos
const repo = session.repo("w1", "-");
const { tree } = await repo.tree();
const diff = await repo.diff("origin/main");
const file = await repo.file("src/index.ts");

// spec bundles, streamed live
const receipt = await agent.spec("checkout-flow", "draft the design");
const stop = session.bundles("w1").follow(receipt.bundle, (b) => render(b.files));
// … stop() when done

// live status events + rpc over one socket
broker.events.on("agent_status", (e) => console.log(e));
broker.events.connect(); // auth via ["bearer", token] subprotocols — never the URL
```

Errors: every non-2xx reply throws `BrokerApiError {code, message, status,
details}` mapping the broker's envelope 1:1 (`agent_unresponsive`,
`unknown_model`, …); unreachable brokers throw `BrokerNetworkError`.

Tests: `npm -w packages/client test` (unit, mocked fetch/WebSocket);
`npm run build && RUN_INTEGRATION=1 npm -w packages/client run
test:integration` boots the real daemon with a simulated herdr in-process
and drives the full lifecycle over the wire.
