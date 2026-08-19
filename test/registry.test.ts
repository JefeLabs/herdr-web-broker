import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Registry, type InstanceSnapshot } from "../src/registry.js";

const SNAP: InstanceSnapshot = {
  platform: "macos",
  herdr_version: "0.8.0",
  sessions: [
    {
      name: "default",
      agents: [
        { id: "a1", title: "claude", status: "working" },
        { id: "a2", title: "codex", status: "idle" },
      ],
    },
  ],
};

test("replaceSnapshot brings an instance online and rollup counts statuses", () => {
  const r = new Registry();
  const events: string[] = [];
  r.on("online", (e) => events.push(`online:${e.instance}`));
  r.on("snapshot", (e) => events.push(`snapshot:${e.instance}`));
  r.replaceSnapshot("laptop", SNAP);
  const roll = r.rollup();
  assert.equal(roll.length, 1);
  assert.equal(roll[0].instance, "laptop");
  assert.equal(roll[0].online, true);
  assert.ok(roll[0].as_of.endsWith("Z"));
  assert.deepEqual(roll[0].counts, { working: 1, blocked: 0, idle: 1 });
  assert.deepEqual(events, ["online:laptop", "snapshot:laptop"]);
});

test("applyAgentStatus upserts and emits", () => {
  const r = new Registry();
  r.replaceSnapshot("laptop", SNAP);
  let seen: unknown;
  r.on("agent_status", (e) => (seen = e));
  r.applyAgentStatus("laptop", "default", { id: "a1", title: "claude", status: "blocked" });
  assert.deepEqual(r.counts("laptop"), { working: 0, blocked: 1, idle: 1 });
  r.applyAgentStatus("laptop", "default", { id: "a3", title: "new", status: "working" });
  assert.deepEqual(r.counts("laptop"), { working: 1, blocked: 1, idle: 1 });
  assert.deepEqual(seen, {
    instance: "laptop",
    session: "default",
    agent: { id: "a3", title: "new", status: "working" },
  });
});

test("session add/remove reshape the instance", () => {
  const r = new Registry();
  r.replaceSnapshot("laptop", SNAP);
  r.applySessionAdded("laptop", { name: "extra", agents: [] });
  assert.deepEqual(Object.keys(r.get("laptop")!.sessions).sort(), ["default", "extra"]);
  r.applySessionRemoved("laptop", "default");
  assert.deepEqual(Object.keys(r.get("laptop")!.sessions), ["extra"]);
});

test("setOffline keeps last-known data and as_of (stale beats silent)", () => {
  const r = new Registry();
  r.replaceSnapshot("laptop", SNAP);
  const asOf = r.get("laptop")!.as_of;
  let off = false;
  r.on("offline", () => (off = true));
  r.setOffline("laptop");
  const e = r.get("laptop")!;
  assert.equal(e.online, false);
  assert.equal(e.as_of, asOf);
  assert.deepEqual(r.counts("laptop"), { working: 1, blocked: 0, idle: 1 });
  assert.equal(off, true);
  r.setOffline("laptop"); // idempotent, no second emit tested via flag reset
});

test("persistence survives restart as offline stale data", () => {
  const d = mkdtempSync(join(tmpdir(), "hwb-"));
  const path = join(d, "registry.json");
  const r1 = new Registry(path);
  r1.replaceSnapshot("laptop", SNAP);
  const r2 = new Registry(path);
  r2.load();
  const e = r2.get("laptop")!;
  assert.equal(e.online, false);
  assert.equal(e.platform, "macos");
  assert.deepEqual(r2.counts("laptop"), { working: 1, blocked: 0, idle: 1 });
});

test("load() tolerates corrupt registry.json and starts empty", () => {
  const d = mkdtempSync(join(tmpdir(), "hwb-"));
  const path = join(d, "registry.json");
  writeFileSync(path, "{ invalid json garbage");
  const r = new Registry(path);
  assert.doesNotThrow(() => r.load());
  assert.deepEqual(r.instances(), []);
});
