import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBrokerMethod } from "../src/workspace-ops.js";
import { setup } from "./ops-harness.js";
import { scratchRepo } from "./util.js";

/** The broker writes `<cmd>; echo $? > .herdr/exits/<id>` into the pane.
 * The fake herdr has no shell, so the test plays the shell's part: capture
 * the id out of the sent text, then drop the file the shell would write. */
function idFrom(text: string): string {
  const m = /exits\/([0-9a-f]+)/.exec(text);
  if (!m) throw new Error(`sent text carries an exits path: ${text}`);
  return m[1];
}

test("exec returns the wrapped command's exit code once the drop file lands", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    const sent: string[] = [];
    t.fake.handlers.set("pane.send_input", (p) => {
      sent.push((p as { text: string }).text);
      return { type: "ok" };
    });

    const run = runBrokerMethod(t.deps, "default", "broker.pane.exec", {
      pane_id: "w1:p1",
      command: "./validate.sh",
    });
    await new Promise((r) => setTimeout(r, 50)); // let send_input land
    const dir = join(cwd, ".herdr", "exits");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, idFrom(sent[0])), "0\n");

    assert.deepEqual(await run, { pane_id: "w1:p1", exit_code: 0, ok: true });
  } finally {
    await t.teardown();
  }
});

test("a nonzero exit is a 200-shaped ok:false, not an error", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    const sent: string[] = [];
    t.fake.handlers.set("pane.send_input", (p) => {
      sent.push((p as { text: string }).text);
      return { type: "ok" };
    });

    const run = runBrokerMethod(t.deps, "default", "broker.pane.exec", { pane_id: "w1:p1", command: "false" });
    await new Promise((r) => setTimeout(r, 50));
    const dir = join(cwd, ".herdr", "exits");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, idFrom(sent[0])), "1\n");

    const r = (await run) as { ok: boolean; exit_code: number };
    assert.equal(r.ok, false);
    assert.equal(r.exit_code, 1);
  } finally {
    await t.teardown();
  }
});

test("a command that never finishes times out as upstream_timeout", async () => {
  const t = await setup();
  try {
    t.deps.index.set("default", "w1", { cwd: scratchRepo() });
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    await assert.rejects(
      () =>
        runBrokerMethod(t.deps, "default", "broker.pane.exec", {
          pane_id: "w1:p1",
          command: "sleep 99",
          timeout_ms: 1000,
        }),
      /no exit code within/,
    );
  } finally {
    await t.teardown();
  }
});

test("a multi-line command is refused rather than half-submitted", async () => {
  const t = await setup();
  try {
    t.deps.index.set("default", "w1", { cwd: scratchRepo() });
    await assert.rejects(
      () => runBrokerMethod(t.deps, "default", "broker.pane.exec", { pane_id: "w1:p1", command: "a\nb" }),
      /single line/,
    );
  } finally {
    await t.teardown();
  }
});
