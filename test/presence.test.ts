import test from "node:test";
import assert from "node:assert/strict";
import { Presence } from "../src/presence.js";

test("identify records the user; list shows them; touch keeps them fresh", async () => {
  const p = new Presence(120); // 120ms TTL for the test
  const entry = p.identify("laptop", { name: "Kathia", email: "kathia@example.com" });
  assert.equal(entry.token, "laptop");
  assert.equal(entry.name, "Kathia");
  assert.ok(entry.since && entry.last_seen);

  await new Promise((r) => setTimeout(r, 80));
  p.touch("laptop"); // activity refreshes last_seen
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(p.list().length, 1, "touched entries survive past the original TTL");

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(p.list().length, 0, "silent entries expire");
});

test("identity is opt-in: touch alone never creates an entry; remove clears it", () => {
  const p = new Presence();
  p.touch("ghost");
  assert.equal(p.list().length, 0);
  p.identify("laptop", {});
  assert.equal(p.list()[0].name, undefined);
  p.remove("laptop");
  assert.equal(p.list().length, 0);
});

test("re-identifying updates identity but keeps the original since", async () => {
  const p = new Presence();
  const first = p.identify("laptop", { name: "A" });
  await new Promise((r) => setTimeout(r, 20));
  const second = p.identify("laptop", { name: "B", email: "b@x.dev" });
  assert.equal(second.since, first.since);
  assert.equal(p.list()[0].name, "B");
});
