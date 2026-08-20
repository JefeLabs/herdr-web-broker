import test from "node:test";
import assert from "node:assert/strict";
import { AuthLimiter } from "../src/auth-limit.js";

test("blocks an ip after max failures inside the window, and only that ip", () => {
  let now = 1_000_000;
  const lim = new AuthLimiter({ maxFailures: 3, windowMs: 60_000, now: () => now });
  assert.equal(lim.blocked("1.2.3.4"), false);
  lim.record("1.2.3.4");
  lim.record("1.2.3.4");
  assert.equal(lim.blocked("1.2.3.4"), false, "under the limit");
  lim.record("1.2.3.4");
  assert.equal(lim.blocked("1.2.3.4"), true, "limit reached");
  assert.equal(lim.blocked("5.6.7.8"), false, "other ips unaffected");
});

test("failures age out of the sliding window", () => {
  let now = 1_000_000;
  const lim = new AuthLimiter({ maxFailures: 2, windowMs: 60_000, now: () => now });
  lim.record("ip");
  now += 59_000;
  lim.record("ip");
  assert.equal(lim.blocked("ip"), true);
  now += 2_000; // first failure is now outside the window
  assert.equal(lim.blocked("ip"), false);
});

test("a successful auth clears the ip's failure history", () => {
  const lim = new AuthLimiter({ maxFailures: 2, windowMs: 60_000 });
  lim.record("ip");
  lim.record("ip");
  assert.equal(lim.blocked("ip"), true);
  lim.success("ip");
  assert.equal(lim.blocked("ip"), false);
});
