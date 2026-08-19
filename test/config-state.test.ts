import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, DEFAULT_LISTEN } from "../src/config.js";
import { ChildrenStore, ensureAdminToken, readLock, writeLock, clearLock } from "../src/state.js";

const dir = () => mkdtempSync(join(tmpdir(), "hwb-"));

test("loadConfig returns spec defaults when no file exists", () => {
  const c = loadConfig(dir());
  assert.equal(c.listen, DEFAULT_LISTEN);
  assert.deepEqual(c.client_tokens, []);
  assert.deepEqual(c.policy.remote_deny, ["server.stop", "server.reload_config", "plugin.*"]);
  assert.equal(c.parent, undefined);
});

test("loadConfig parses a full config.toml", () => {
  const d = dir();
  writeFileSync(
    join(d, "config.toml"),
    [
      'listen = "0.0.0.0:9999"',
      "[[client_tokens]]",
      'name = "cli"',
      'token = "tok-a"',
      "[parent]",
      'address = "ws://parent:7591"',
      'secret = "sss"',
      'name = "laptop"',
      "[policy]",
      'remote_deny = ["server.stop"]',
    ].join("\n"),
  );
  const c = loadConfig(d);
  assert.equal(c.listen, "0.0.0.0:9999");
  assert.deepEqual(c.client_tokens, [{ name: "cli", token: "tok-a" }]);
  assert.deepEqual(c.parent, { address: "ws://parent:7591", secret: "sss", name: "laptop" });
  assert.deepEqual(c.policy.remote_deny, ["server.stop"]);
});

test("saveConfig round-trips through loadConfig", () => {
  const d = dir();
  const c = loadConfig(d);
  c.parent = { address: "ws://p:1", secret: "s", name: "n" };
  saveConfig(d, c);
  assert.deepEqual(loadConfig(d).parent, { address: "ws://p:1", secret: "s", name: "n" });
});

test("ChildrenStore persists across instances and deletes", () => {
  const d = dir();
  const a = new ChildrenStore(d);
  assert.equal(a.get("laptop"), undefined);
  a.set("laptop", "hash1");
  const b = new ChildrenStore(d);
  assert.deepEqual(b.get("laptop"), { secret_hash: "hash1" });
  assert.deepEqual(b.names(), ["laptop"]);
  assert.equal(b.delete("laptop"), true);
  assert.equal(b.delete("laptop"), false);
  assert.equal(new ChildrenStore(d).get("laptop"), undefined);
});

test("ensureAdminToken is stable, non-empty, and mode 0600", () => {
  const d = dir();
  const t1 = ensureAdminToken(d);
  assert.ok(t1.length >= 40);
  assert.equal(ensureAdminToken(d), t1);
  assert.equal(statSync(join(d, "admin-token")).mode & 0o777, 0o600);
});

test("lockfile round-trips and clears", () => {
  const d = dir();
  assert.equal(readLock(d), undefined);
  writeLock(d, { pid: 123, listen: "127.0.0.1:7591" });
  assert.deepEqual(readLock(d), { pid: 123, listen: "127.0.0.1:7591" });
  clearLock(d);
  assert.equal(readLock(d), undefined);
});

test("ChildrenStore tolerates corrupt JSON and returns empty", () => {
  const d = dir();
  writeFileSync(join(d, "children.json"), "not json{");
  const store = new ChildrenStore(d);
  assert.equal(store.get("x"), undefined);
  assert.deepEqual(store.names(), []);
});

test("readLock tolerates corrupt JSON and returns undefined", () => {
  const d = dir();
  writeFileSync(join(d, "daemon.lock"), "not json{");
  assert.equal(readLock(d), undefined);
});
