import test from "node:test";
import assert from "node:assert/strict";
import { BrokerError, httpStatus } from "../src/errors.js";
import { methodDenied, DEFAULT_REMOTE_DENY } from "../src/policy.js";
import { mintSecret, hashSecret, verifySecret, checkBearer, matchToken } from "../src/auth.js";

test("httpStatus maps broker codes per spec and unknown codes to 502", () => {
  assert.equal(httpStatus("unauthorized"), 401);
  assert.equal(httpStatus("method_denied"), 403);
  assert.equal(httpStatus("unknown_instance"), 404);
  assert.equal(httpStatus("unknown_session"), 404);
  assert.equal(httpStatus("instance_offline"), 503);
  assert.equal(httpStatus("upstream_timeout"), 504);
  assert.equal(httpStatus("not_found"), 502); // herdr passthrough
});

test("BrokerError carries details into the envelope", () => {
  const e = new BrokerError("instance_offline", "tunnel down", { last_seen: "2026-08-18T00:00:00Z" });
  assert.deepEqual(e.toEnvelope(), {
    code: "instance_offline",
    message: "tunnel down",
    last_seen: "2026-08-18T00:00:00Z",
  });
});

test("methodDenied handles exact names and dot-star globs", () => {
  assert.equal(methodDenied("server.stop", DEFAULT_REMOTE_DENY), true);
  assert.equal(methodDenied("plugin.list", DEFAULT_REMOTE_DENY), true);
  assert.equal(methodDenied("plugin.action.invoke", DEFAULT_REMOTE_DENY), true);
  assert.equal(methodDenied("agent.list", DEFAULT_REMOTE_DENY), false);
  assert.equal(methodDenied("pluginx", DEFAULT_REMOTE_DENY), false);
  assert.equal(methodDenied("anything", ["*"]), true);
});

test("secrets round-trip and reject tampering", () => {
  const s = mintSecret();
  assert.ok(s.length >= 40);
  assert.notEqual(mintSecret(), s);
  const h = hashSecret(s);
  assert.equal(verifySecret(s, h), true);
  assert.equal(verifySecret(s + "x", h), false);
});

test("checkBearer accepts a configured token and nothing else", () => {
  const tokens = [{ token: "tok-a" }, { token: "tok-b" }];
  assert.equal(checkBearer("Bearer tok-b", tokens), true);
  assert.equal(checkBearer("Bearer nope", tokens), false);
  assert.equal(checkBearer("tok-a", tokens), false);
  assert.equal(checkBearer(undefined, tokens), false);
});

test("hashed-at-rest entries match without the plaintext ever being stored", () => {
  const tokens = [
    { name: "hashed", token_hash: hashSecret("tok-h") },
    { name: "legacy", token: "tok-p" },
  ];
  // both storage forms authenticate…
  assert.equal(checkBearer("Bearer tok-h", tokens), true);
  assert.equal(checkBearer("Bearer tok-p", tokens), true);
  // …and matchToken still reports the right owner for kick/presence
  assert.equal(matchToken("Bearer tok-h", tokens), "hashed");
  assert.equal(matchToken("Bearer tok-p", tokens), "legacy");
  // presenting a hash as if it were the token must NOT match
  assert.equal(checkBearer(`Bearer ${hashSecret("tok-h")}`, tokens), false);
});

test("a malformed token_hash entry never throws and never matches", () => {
  const tokens = [{ name: "bad", token_hash: "zz-not-hex" }, { name: "ok", token_hash: hashSecret("real") }];
  assert.equal(checkBearer("Bearer anything", tokens), false);
  assert.equal(matchToken("Bearer real", tokens), "ok");
});
