import test from "node:test";
import assert from "node:assert/strict";
import { buildApi, type BuildApiOpts } from "../src/module-api.js";

function opts(granted: string[] = [], over: Partial<BuildApiOpts> = {}): BuildApiOpts {
  return {
    moduleId: "m1",
    granted: granted as never,
    deps: {} as never,
    session: "default",
    instance: "runtime",
    events: { on() {} } as never,
    log: () => {},
    audit: { record: () => {} },
    ...over,
  };
}

test("route() records rather than mounting — the table is fixed after register()", () => {
  const built = buildApi(opts());
  built.api.route("GET", "/x/:id", async () => ({ ok: true }));
  assert.equal(built.routes.length, 1);
  assert.equal(built.routes[0].method, "GET");
  assert.equal(built.routes[0].path, "/x/:id");
});

test("every capability is ABSENT when ungranted — undefined, not a throwing stub", () => {
  const { api } = buildApi(opts([]));
  for (const k of ["git", "files", "workspaces", "agents", "rpc", "on"]) {
    assert.equal((api as unknown as Record<string, unknown>)[k], undefined, `${k} must be absent, not present`);
  }
});

test("log, audit and the error constructors are ALWAYS present", () => {
  const { api } = buildApi(opts([]));
  assert.equal(typeof api.log, "function");
  assert.equal(typeof api.audit, "function");
  assert.equal(typeof api.badRequest, "function");
  assert.equal(typeof api.notFound, "function");
});

test("badRequest and notFound produce the broker's own error shapes", () => {
  const { api } = buildApi(opts([]));
  const bad = api.badRequest("nope") as unknown as { code?: string };
  const missing = api.notFound("gone") as unknown as { code?: string };
  assert.equal(bad.code, "bad_request");
  assert.equal(missing.code, "unknown_workspace");
});

test("log is tagged with the module id so a noisy module is identifiable", () => {
  const lines: string[] = [];
  const built = buildApi(opts([], { log: (m: string) => void lines.push(m) }));
  built.api.log("hello");
  assert.match(lines[0], /m1/);
  assert.match(lines[0], /hello/);
});

test("audit records with the MODULE as actor, so entries are attributable", () => {
  const entries: Array<{ action: string; actor: string; target?: string }> = [];
  const built = buildApi(opts([], { audit: { record: (e) => void entries.push(e) } }));
  built.api.audit("blame.ran", "w1:myrepo");
  assert.equal(entries[0].actor, "module:m1");
  assert.equal(entries[0].action, "blame.ran");
  assert.equal(entries[0].target, "w1:myrepo");
});

test("a route path must start with / and may not escape the module's mount", () => {
  const built = buildApi(opts());
  assert.throws(() => built.api.route("GET", "no-slash", async () => ({})), /must start with/);
  assert.throws(() => built.api.route("GET", "/../escape", async () => ({})), /may not contain/);
});
