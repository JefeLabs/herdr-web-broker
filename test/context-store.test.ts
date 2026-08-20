import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError } from "../src/errors.js";
import {
  activeContextPreamble,
  deleteContext,
  getContext,
  listContext,
  putContext,
  setContextActive,
} from "../src/context-store.js";
import { scratchRepo, sh, tmpDir } from "./util.js";

test("put/list/get round-trips bytes and metadata; the dir self-ignores from git", async () => {
  const cwd = scratchRepo(); // the workspace root IS a repo — the danger case
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  const put = putContext(cwd, "mockup.png", bytes, { contentType: "image/png" });
  assert.equal(put.name, "mockup.png");
  assert.equal(put.size, 6);
  assert.equal(put.active, true);

  const list = listContext(cwd);
  assert.equal(list.length, 1);
  assert.equal(list[0].content_type, "image/png");
  assert.ok(list[0].uploaded_at);

  const got = getContext(cwd, "mockup.png");
  assert.deepEqual(got.content, bytes);
  assert.equal(got.meta.content_type, "image/png");

  // never part of the associated repo
  assert.equal(readFileSync(join(cwd, ".herdr", ".gitignore"), "utf8").trim(), "*");
  const status = sh(cwd, ["status", "--porcelain"]);
  assert.ok(!status.includes(".herdr"), `git must not see context files, saw: ${status}`);
});

test("active files build the prompt preamble; inactive and deleted ones drop out", () => {
  const cwd = tmpDir();
  putContext(cwd, "spec.pdf", Buffer.alloc(1200), { contentType: "application/pdf" });
  putContext(cwd, "notes.txt", Buffer.from("hi"), { contentType: "text/plain", active: false });
  const preamble = activeContextPreamble(cwd);
  assert.ok(preamble && preamble.includes(join(cwd, ".herdr", "context", "spec.pdf")));
  assert.ok(preamble!.includes("application/pdf"));
  assert.ok(!preamble!.includes("notes.txt"), "inactive files stay out of prompts");

  setContextActive(cwd, "notes.txt", true);
  assert.ok(activeContextPreamble(cwd)!.includes("notes.txt"));
  setContextActive(cwd, "spec.pdf", false);
  deleteContext(cwd, "notes.txt");
  assert.equal(activeContextPreamble(cwd), undefined);
  assert.equal(listContext(cwd).length, 1);
});

test("names are single sanitized segments; unknown names 404; the cap holds", () => {
  const cwd = tmpDir();
  for (const bad of ["../escape.pdf", "a/b.png", ".hidden", ""]) {
    assert.throws(() => putContext(cwd, bad, Buffer.from("x"), {}), (e: BrokerError) => e.code === "bad_request", bad);
  }
  assert.throws(() => getContext(cwd, "ghost.pdf"), (e: BrokerError) => e.code === "unknown_context");
  assert.throws(() => setContextActive(cwd, "ghost.pdf", true), (e: BrokerError) => e.code === "unknown_context");
  assert.throws(
    () => putContext(cwd, "big.bin", Buffer.alloc(8 * 1024 * 1024 + 1), {}),
    (e: BrokerError) => e.code === "bad_request" && /8MB/.test(e.message),
  );
  assert.ok(!existsSync(join(cwd, ".herdr", "context", "escape.pdf")));
});
