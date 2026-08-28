# @jefelabs/herdr-broker-module

Types for authoring [herdr-web-broker](https://github.com/JefeLabs/herdr-web-broker) modules — endpoints and event handlers an operator adds to a running broker.

Modules are plain `.js`. The broker `import()`s the file and owns no build step. Write TypeScript and compile, or annotate JavaScript with JSDoc:

```js
/** @type {import("@jefelabs/herdr-broker-module").BrokerModule} */
const mod = {
  id: "blame",
  abi: 1,
  capabilities: ["git.read"],
  register(api) {
    api.route("GET", "/repos/:repo/blame", async (ctx) => ({
      blame: await api.git.raw(ctx.workspaceId, ctx.params.repo, [
        "blame", "--porcelain", "--", ctx.query.get("file"),
      ]),
    }));
  },
};
export default mod;
```

Install it in the broker's `config.toml`:

```toml
[[modules]]
path = "./modules/blame.js"
capabilities = ["git.read"]
```

It serves at `GET /v1/modules/blame/repos/{repo}/blame?workspace_id=…`.

## Two things to know before you write one

**An ungranted capability is `undefined`, not an error.** The grant is the
intersection of your `capabilities` array and the operator's
`config.toml` list — neither side alone can widen it. Declare `["files"]`
and `api.git` does not exist on the object; calling it throws a TypeError
naming the missing property, at your load test rather than in production.

**Modules are not sandboxed.** They run in the broker's process with its
privileges, and `node:fs` is one import away. Capabilities make the safe
path the narrow path — they are not a confinement. Installing a module is
installing code, with the same trust as an npm dependency. That is why
modules can only be declared in `config.toml`, which already holds the
broker's client tokens, and never through the API.

## What the capabilities grant

| capability | grants |
| --- | --- |
| `git.read` | `api.git.{raw,diff,log,tree}` — `raw` takes an argv **array**, so there is no shell; destructive porcelain is denied |
| `git.write` | `api.git.{commit,push}` — audited |
| `files` | `api.files.{read,write,list}` — every path resolved against the workspace, symlinks included |
| `workspaces` | `api.workspaces.{list,cwd}` — read-only |
| `agents` | `api.agents.{list,prompt,ask}` — `ask` takes the same per-pane lock core does |
| `rpc` | `api.rpc(method, params)` — subject to the broker's `remote_deny` policy |
| `events` | `api.on(event, handler)` — consume-only |

`api.log`, `api.audit`, `api.badRequest` and `api.notFound` are always
present; they carry no authority.

## Events

`api.on` subscribes to herdr's own events and to `broker.*` events the
broker emits and herdr cannot know:

| event | fires when |
| --- | --- |
| `broker.agent.spawned` | a spawn completed, after the readiness gate |
| `broker.agent.spawn_failed` | a spawn threw, with the error code |
| `broker.ask.completed` | an `ask` returned |
| `broker.ask.unresponsive` | `agent_unresponsive` fired, **carrying `evidence`** |
| `broker.repo.pushed` | a push succeeded |
| `broker.exec.finished` | a pane exec returned, with `exit_code` |

Delivery is **at-most-once**, fire-and-forget. The broker's event stream
is live-only with no replay, so a handler layer promising more would be a
false guarantee. If you must not miss events, subscribe to `WS /events`
and own your durability.

## Licence

MIT
