import test from "node:test";
import assert from "node:assert/strict";
import { BrokerError } from "../src/errors.js";
import { EnvRegistry } from "../src/env-registry.js";
import { tmpDir } from "./util.js";

function reg(extra: Partial<ConstructorParameters<typeof EnvRegistry>[0]> = {}) {
  return new EnvRegistry({ stateDir: tmpDir(), ...extra });
}

test("set validates name and value; list never exposes values", () => {
  const r = reg();
  assert.throws(() => r.set("lower_case", "v", {}), (e: BrokerError) => e.code === "bad_request");
  assert.throws(() => r.set("1BAD", "v", {}), (e: BrokerError) => e.code === "bad_request");
  assert.throws(() => r.set("A".repeat(129), "v", {}), (e: BrokerError) => e.code === "bad_request");
  assert.throws(() => r.set("BIG", "x".repeat(8193), {}), (e: BrokerError) => e.code === "bad_request");
  const out = r.set("COPILOT_GITHUB_TOKEN", "sekret-value", { kind: "copilot" });
  assert.deepEqual(out, { name: "COPILOT_GITHUB_TOKEN", scope: { kind: "copilot" } });
  const listed = r.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "COPILOT_GITHUB_TOKEN");
  assert.equal(listed[0].source, "manual");
  assert.ok(listed[0].set_at);
  assert.ok(!JSON.stringify(listed).includes("sekret-value"));
});

test("upsert replaces same (name, kind, session) key; delete removes exactly one scope", () => {
  const r = reg();
  r.set("T", "v1", { kind: "copilot" });
  r.set("T", "v2", { kind: "copilot" });
  r.set("T", "v3", {});
  assert.equal(r.list().length, 2);
  r.delete("T", { kind: "copilot" });
  assert.equal(r.list().length, 1);
  assert.throws(() => r.delete("T", { kind: "copilot" }), (e: BrokerError) => e.code === "unknown_env");
  r.delete("T", {});
  assert.equal(r.list().length, 0);
});

test("resolveForSpawn: scope filtering and specificity precedence", async () => {
  const r = reg();
  r.set("A", "wild", {});
  r.set("A", "kind", { kind: "copilot" });
  r.set("A", "both", { kind: "copilot", session: "default" });
  r.set("B", "sess", { session: "default" });
  r.set("C", "other", { kind: "claude" });
  const out = await r.resolveForSpawn("default", "copilot");
  assert.deepEqual(out, { A: "both", B: "sess" });
  const out2 = await r.resolveForSpawn("other-session", "copilot");
  assert.deepEqual(out2, { A: "kind" });
});

test("disabled registry refuses set/list/delete but constructor still works", () => {
  const r = reg({ enabled: false });
  assert.equal(r.enabled, false);
  assert.throws(() => r.set("X", "v", {}), (e: BrokerError) => e.code === "env_disabled");
  assert.throws(() => r.list(), (e: BrokerError) => e.code === "env_disabled");
  assert.throws(() => r.delete("X", {}), (e: BrokerError) => e.code === "env_disabled");
});

const node = process.execPath;

test("hook runner: stdout becomes the value, trailing newline trimmed", async () => {
  const r = new EnvRegistry({
    stateDir: tmpDir(),
    hooks: [{ name: "HOOKED", kind: "copilot", command: [node, "-e", "console.log('hook-value')"] }],
  });
  const out = await r.resolveForSpawn("default", "copilot");
  assert.deepEqual(out, { HOOKED: "hook-value" });
});

test("hook runner: manual entry suppresses the hook entirely", async () => {
  let ran = 0;
  const r = new EnvRegistry({
    stateDir: tmpDir(),
    hooks: [{ name: "HOOKED", command: [node, "-e", "console.log('from-hook')"] }],
    hookRunner: async () => { ran += 1; return "from-hook"; },
  });
  r.set("HOOKED", "from-manual", {});
  const out = await r.resolveForSpawn("default", "copilot");
  assert.deepEqual(out, { HOOKED: "from-manual" });
  assert.equal(ran, 0);
});

test("hook runner: non-zero exit, empty stdout, and timeout all fail as env_hook_failed", async () => {
  const fail = (hooks: { name: string; command: string[]; timeout_ms?: number }[]) =>
    new EnvRegistry({ stateDir: tmpDir(), hooks }).resolveForSpawn("default", "copilot");
  await assert.rejects(
    fail([{ name: "EXITS", command: [node, "-e", "process.exit(3)"] }]),
    (e: BrokerError) => e.code === "env_hook_failed" && e.details.exit_code === 3,
  );
  await assert.rejects(
    fail([{ name: "EMPTY", command: [node, "-e", ""] }]),
    (e: BrokerError) => e.code === "env_hook_failed",
  );
  await assert.rejects(
    fail([{ name: "SLOW", command: [node, "-e", "setTimeout(()=>{}, 30000)"], timeout_ms: 1001 }]),
    (e: BrokerError) => e.code === "env_hook_failed",
  );
});
