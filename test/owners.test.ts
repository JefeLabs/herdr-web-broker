import test from "node:test";
import assert from "node:assert/strict";
import { OwnerRegistry } from "../src/owners.js";
import { BrokerError } from "../src/errors.js";
import { tmpDir } from "./util.js";

test("bind is sticky per email: deterministic non-default name, same token re-binds, another token is refused", () => {
  const dir = tmpDir();
  const owners = new OwnerRegistry(dir);

  const first = owners.bind("kathia@example.com", "tok-a");
  assert.ok(first.session.startsWith("u-"), "owned sessions live in their own namespace");
  assert.notEqual(first.session, "default");
  assert.equal(first.created, true);

  // deterministic: the same email always maps to the same session name
  const again = owners.bind("kathia@example.com", "tok-a");
  assert.equal(again.session, first.session);
  assert.equal(again.created, false);

  // sticky: a different token cannot claim a bound email
  assert.throws(
    () => owners.bind("kathia@example.com", "tok-b"),
    (e: BrokerError) => e.code === "email_taken",
  );

  // persisted: a fresh registry over the same state dir sees the binding
  const reopened = new OwnerRegistry(dir);
  assert.equal(reopened.byEmail("kathia@example.com")?.session, first.session);
  assert.equal(reopened.bySession(first.session)?.email, "kathia@example.com");
  assert.equal(reopened.byToken("tok-a")?.email, "kathia@example.com");
});

test("rebind moves an email to a new token; remove frees it; list enumerates", () => {
  const dir = tmpDir();
  const owners = new OwnerRegistry(dir);
  const b = owners.bind("edwin@example.com", "tok-1");

  owners.rebind("edwin@example.com", "tok-2");
  assert.equal(owners.byToken("tok-2")?.session, b.session);
  assert.equal(owners.byToken("tok-1"), undefined);
  // rebinding an unknown email is an error, not a silent bind
  assert.throws(
    () => owners.rebind("ghost@example.com", "tok-9"),
    (e: BrokerError) => e.code === "unknown_email",
  );

  assert.equal(owners.list().length, 1);
  owners.remove("edwin@example.com");
  assert.equal(owners.byEmail("edwin@example.com"), undefined);
  assert.equal(owners.list().length, 0);

  // after removal the email is free to bind again — fresh start, same name
  const again = owners.bind("edwin@example.com", "tok-3");
  assert.equal(again.session, b.session, "deterministic name survives the teardown cycle");
  assert.equal(again.created, true);
});

test("session names are safe slugs: weird locals sanitize, distinct emails never collide", () => {
  const owners = new OwnerRegistry(tmpDir());
  const odd = owners.bind("Some.Käthia+work@Example.COM", "t1");
  assert.match(odd.session, /^u-[a-z0-9-]+-[0-9a-f]{6}$/);
  // same local part, different domain — the hash disambiguates
  const other = owners.bind("some.käthia+work@other.org", "t2");
  assert.notEqual(other.session, odd.session);
});
