import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeHerdr } from "./fake-herdr.js";
import { herdrAnswers, tmpDir } from "./util.js";

test("herdrAnswers: a socket with a herdr behind it answers", async () => {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  await fake.listen();
  try {
    assert.equal(await herdrAnswers(fake.socketPath), true);
  } finally {
    await fake.close();
  }
});

test("herdrAnswers: a path that EXISTS but has nothing behind it does not", async () => {
  // The whole point. live-smoke gated on existsSync, which a leftover socket
  // file passes indefinitely after the herdr that made it is gone — so the
  // test ran against a dead endpoint and failed on an assertion instead of
  // skipping. Liveness is answered by asking, not by stat().
  const stale = join(tmpDir(), "herdr.sock");
  writeFileSync(stale, "");
  assert.equal(existsSync(stale), true, "the check that used to gate the test");
  assert.equal(await herdrAnswers(stale), false, "the check that gates it now");
});

test("herdrAnswers: a path that does not exist does not", async () => {
  assert.equal(await herdrAnswers(join(tmpDir(), "absent.sock")), false);
});
