import test from "node:test";
import assert from "node:assert/strict";
import { API_VERSION, MIN_HERDR_VERSION, parseVersion, compareVersions, verdictFor } from "../src/version.js";

test("parseVersion pulls a triple out of whatever herdr --version prints", () => {
  assert.deepEqual(parseVersion("0.8.0"), [0, 8, 0]);
  assert.deepEqual(parseVersion("herdr 0.8.3"), [0, 8, 3]);
  assert.deepEqual(parseVersion("v1.2.9-rc1+build"), [1, 2, 9]);
  assert.deepEqual(parseVersion("0.9"), [0, 9, 0], "a missing patch reads as .0");
  assert.equal(parseVersion("unknown"), undefined, "no triple means unknown, not zero");
  assert.equal(parseVersion(""), undefined);
});

test("compareVersions orders major, then minor, then patch", () => {
  assert.equal(compareVersions([0, 8, 0], [0, 8, 0]), 0);
  assert.equal(compareVersions([0, 8, 0], [0, 9, 0]), -1);
  assert.equal(compareVersions([1, 0, 0], [0, 99, 99]), 1);
  assert.equal(compareVersions([0, 8, 1], [0, 8, 0]), 1);
});

test("below the floor REFUSES — known-incompatible must not start", () => {
  const v = verdictFor("0.7.9");
  assert.equal(v.ok, false);
  assert.match((v as { refuse: string }).refuse, /older than the minimum/);
  assert.match((v as { refuse: string }).refuse, new RegExp(MIN_HERDR_VERSION.replace(/\./g, "\\.")));
});

test("inside the tested line is silent — no warning noise on the happy path", () => {
  assert.deepEqual(verdictFor("0.8.0"), { ok: true });
  assert.deepEqual(verdictFor("0.8.7"), { ok: true }, "a patch bump stays inside the tested 0.8 line");
  assert.deepEqual(verdictFor("herdr 0.8.12"), { ok: true });
});

test("above the tested ceiling WARNS but starts — unknown is not known-broken", () => {
  const v = verdictFor("0.9.0");
  assert.equal(v.ok, true);
  assert.match((v as { warn: string }).warn, /NEWER than the newest line/);
  assert.match((v as { warn: string }).warn, /undocumented herdr wire behavior/);
  assert.equal(verdictFor("1.0.0").ok, true, "a major bump warns too, it does not refuse");
});

test("an unreadable version warns rather than refusing or crashing", () => {
  const v = verdictFor("unknown");
  assert.equal(v.ok, true);
  assert.match((v as { warn: string }).warn, /could not read a version/);
});

test("the refuse/warn split is the whole policy: only below-floor blocks startup", () => {
  // The asymmetry is the point — assert it directly so a future edit that
  // makes an untested-but-newer herdr fatal fails loudly here.
  assert.equal(verdictFor("0.7.0").ok, false);
  assert.equal(verdictFor("0.8.0").ok, true);
  assert.equal(verdictFor("99.0.0").ok, true);
});

test("API_VERSION is the bare segment, not a path", () => {
  assert.equal(API_VERSION, "v1");
  assert.ok(!API_VERSION.includes("/"), "callers build the path; this is just the segment");
});
