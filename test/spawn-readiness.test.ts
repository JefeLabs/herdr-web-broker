import test from "node:test";
import assert from "node:assert/strict";
import { awaitShellReady, readinessSentinel, type ReadinessDeps } from "../src/spawn-readiness.js";

/** A recording stub for `local.request`. `answer` decides what each method
 * does, so a test can make `pane.wait_for_output` resolve, reject, or hang
 * without a herdr. */
function stub(answer: (method: string) => Promise<unknown>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const deps: ReadinessDeps = {
    local: {
      request(_session: string, method: string, params: unknown) {
        calls.push({ method, params: params as Record<string, unknown> });
        return answer(method);
      },
    },
  };
  return { deps, calls };
}

const ok = () => Promise.resolve({});

test("the sentinel waits for the exact string it sends", () => {
  const s = readinessSentinel();
  assert.ok(s.text.includes(s.match), "the command must contain the string awaited");
  assert.match(s.text, /^printf /, "a printf is shell-agnostic — no prompt pattern, no shell detection");
});

test("two sentinels never collide", () => {
  // A pane reused across spawns (pane.split into an existing workspace) can
  // still hold a previous sentinel line. Without a per-spawn id the second
  // spawn matches the FIRST spawn's echo and declares a cold shell ready.
  const a = readinessSentinel();
  const b = readinessSentinel();
  assert.notEqual(a.match, b.match);
});

test("a shell that echoes the sentinel reports ready", async () => {
  const { deps, calls } = stub(ok);
  const ready = await awaitShellReady(deps, "default", "w1:p1");
  assert.equal(ready, true);
  assert.deepEqual(calls.map((c) => c.method), ["pane.send_input", "pane.wait_for_output"]);
  const sent = String(calls[0].params.text);
  const awaited = (calls[1].params.match as { value: string }).value;
  assert.ok(sent.includes(awaited), "sends and awaits the same marker");
});

test("a sentinel that never echoes degrades instead of throwing", async () => {
  // The whole point: readiness is best-effort. A check that can BLOCK a spawn
  // is a new failure mode, and the agent_pane_busy retry is still the floor.
  const { deps } = stub((m) => (m === "pane.wait_for_output" ? Promise.reject(new Error("timeout")) : ok()));
  const ready = await awaitShellReady(deps, "default", "w1:p1");
  assert.equal(ready, false, "reports not-ready rather than propagating");
});

test("a send that fails degrades too", async () => {
  const { deps } = stub((m) => (m === "pane.send_input" ? Promise.reject(new Error("nope")) : ok()));
  assert.equal(await awaitShellReady(deps, "default", "w1:p1"), false);
});

test("timeout 0 disables the sentinel entirely", async () => {
  const { deps, calls } = stub(ok);
  deps.readinessTimeoutMs = 0;
  assert.equal(await awaitShellReady(deps, "default", "w1:p1"), false);
  assert.deepEqual(calls, [], "no round trip at all");
});

test("a prefix is sent ahead of the sentinel, on one line, in order", async () => {
  // The env drop-file path composes into this same send_input:
  //   . <drop>; rm -f <drop>; printf '<marker>\n'
  // A regression that dropped the source while keeping the sentinel would
  // otherwise pass every other test here.
  const { deps, calls } = stub(ok);
  const s = await awaitShellReady(deps, "default", "w1:p1", { prefix: " . /tmp/drop; rm -f /tmp/drop" });
  assert.equal(s, true);
  const text = String(calls[0].params.text);
  assert.ok(text.startsWith(" . /tmp/drop; rm -f /tmp/drop;"), `prefix must lead: ${text}`);
  assert.match(text, /printf '__herdr_ready_[0-9a-f]+__/);
  assert.ok(
    text.indexOf("rm -f") < text.indexOf("printf"),
    "the shell runs these sequentially, so the sentinel cannot echo before the env is sourced",
  );
});

test("the prefix is still sent when the sentinel is disabled", async () => {
  // Turning readiness off must not turn ENV INJECTION off — they share a send.
  const { deps, calls } = stub(ok);
  deps.readinessTimeoutMs = 0;
  await awaitShellReady(deps, "default", "w1:p1", { prefix: " . /tmp/drop; rm -f /tmp/drop" });
  assert.deepEqual(calls.map((c) => c.method), ["pane.send_input"]);
  assert.equal(String(calls[0].params.text), " . /tmp/drop; rm -f /tmp/drop");
});

test("a failed prefix send is reported, so env injection can still fail loudly", async () => {
  // spawn() must be able to tell "env injection broke" from "shell was slow":
  // the first is a real error the caller needs, the second is best-effort.
  const { deps } = stub(() => Promise.reject(new Error("send failed")));
  await assert.rejects(
    () => awaitShellReady(deps, "default", "w1:p1", { prefix: " . /tmp/drop", throwOnSendFailure: true }),
    /send failed/,
  );
});

test("it asks for the visible screen", async () => {
  // WT-7 (2026-08-29, herdr 0.8.2) confirmed wait_for_output matches the
  // pane's own echoed input on BOTH visible and recent. visible is the live
  // screen and the sentinel is the newest line, so visible is the tighter ask.
  const { deps, calls } = stub(ok);
  await awaitShellReady(deps, "default", "w1:p1");
  assert.equal(calls[1].params.source, "visible");
});
