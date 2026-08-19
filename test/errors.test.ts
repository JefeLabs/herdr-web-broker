import test from "node:test";
import assert from "node:assert/strict";
import { BrokerError, httpStatus } from "../src/errors.js";

test("workspace/repo/git codes map to their HTTP statuses", () => {
  assert.equal(httpStatus("unknown_workspace"), 404);
  assert.equal(httpStatus("unknown_repo"), 404);
  assert.equal(httpStatus("git_error"), 502);
});

test("BrokerError details flow into the envelope", () => {
  const e = new BrokerError("git_error", "boom", { workspace_id: "w2" });
  assert.deepEqual(e.toEnvelope(), { code: "git_error", message: "boom", workspace_id: "w2" });
});
