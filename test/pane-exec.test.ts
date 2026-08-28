import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerError } from "../src/errors.js";
import { runBrokerMethod } from "../src/workspace-ops.js";
import { setup } from "./ops-harness.js";
import { scratchRepo, tmpDir } from "./util.js";

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
    const sent: Array<{ pane_id?: unknown; text: string; keys?: unknown }> = [];
    t.fake.handlers.set("pane.send_input", (p) => {
      sent.push(p as { pane_id?: unknown; text: string; keys?: unknown });
      return { type: "ok" };
    });

    const run = runBrokerMethod(t.deps, "default", "broker.pane.exec", {
      pane_id: "w1:p1",
      command: "./validate.sh",
    });
    await new Promise((r) => setTimeout(r, 50)); // let send_input land
    const dir = join(cwd, ".herdr", "exits");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, idFrom(sent[0].text)), "0\n");

    assert.deepEqual(await run, { pane_id: "w1:p1", exit_code: 0, ok: true });
    // The one thing this endpoint exists to do: actually submit the
    // user's command, not just the wrapper around it. A regression that
    // drops the command from the sent text must fail this test even
    // though the exit-code plumbing above still "passes".
    assert.match(sent[0].text, /^\.\/validate\.sh; echo \$\? > \.herdr\/exits\/[0-9a-f]+$/);
    assert.equal(sent[0].pane_id, "w1:p1");
    assert.deepEqual(sent[0].keys, ["Enter"]);
  } finally {
    await t.teardown();
  }
});

test("a nonzero exit is a 200-shaped ok:false, not an error", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    const sent: Array<{ pane_id?: unknown; text: string; keys?: unknown }> = [];
    t.fake.handlers.set("pane.send_input", (p) => {
      sent.push(p as { pane_id?: unknown; text: string; keys?: unknown });
      return { type: "ok" };
    });

    const run = runBrokerMethod(t.deps, "default", "broker.pane.exec", { pane_id: "w1:p1", command: "false" });
    await new Promise((r) => setTimeout(r, 50));
    const dir = join(cwd, ".herdr", "exits");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, idFrom(sent[0].text)), "1\n");

    const r = (await run) as { ok: boolean; exit_code: number };
    assert.equal(r.ok, false);
    assert.equal(r.exit_code, 1);
    assert.match(sent[0].text, /^false; echo \$\? > \.herdr\/exits\/[0-9a-f]+$/);
    assert.deepEqual(sent[0].keys, ["Enter"]);
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

test("a late-landing exit code is still returned, not discarded as a timeout", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.deps.askPollMs = 600;
    t.fake.handlers.set("pane.send_input", (p) => {
      const dir = join(cwd, ".herdr", "exits");
      mkdirSync(dir, { recursive: true });
      const id = idFrom((p as { text: string }).text);
      // Lands in the gap between the loop's last poll (t=600, deadline
      // t=1000) and the deadline itself — only the final post-loop check
      // (mirroring askInner's) catches this.
      setTimeout(() => writeFileSync(join(dir, id), "0\n"), 800);
      return { type: "ok" };
    });

    const out = (await runBrokerMethod(t.deps, "default", "broker.pane.exec", {
      pane_id: "w1:p1",
      command: "true",
      timeout_ms: 1000,
    })) as { exit_code: number; ok: boolean };
    assert.equal(out.exit_code, 0);
    assert.equal(out.ok, true);
  } finally {
    await t.teardown();
  }
});

test("exec: an exits dir that escapes the workspace via a symlink is rejected", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    const outside = tmpDir();
    mkdirSync(join(cwd, ".herdr"), { recursive: true });
    symlinkSync(outside, join(cwd, ".herdr", "exits"));
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.pane.exec", { pane_id: "w1:p1", command: "true", timeout_ms: 1000 }),
      (e: BrokerError) => e.code === "unknown_workspace",
    );
    assert.deepEqual(readdirSync(outside), [], "the escape guard runs before anything is created through it");
  } finally {
    await t.teardown();
  }
});

// The deeper form of the same escape: .herdr ITSELF is the symlink, not
// just the leaf under it. `exits` doesn't exist yet at all in this case —
// a guard that only checks `dir`'s own existence would miss an already-
// malicious .herdr and let mkdirSync create `exits`, and writeFileSync
// create `.gitignore`, through it before the escape was ever detected.
test("exec: .herdr itself symlinked outside the workspace is rejected before anything is created through it", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    const outside = tmpDir();
    symlinkSync(outside, join(cwd, ".herdr"));
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("pane.send_input", () => ({ type: "ok" }));
    await assert.rejects(
      runBrokerMethod(t.deps, "default", "broker.pane.exec", { pane_id: "w1:p1", command: "true", timeout_ms: 1000 }),
      (e: BrokerError) => e.code === "unknown_workspace",
    );
    assert.deepEqual(readdirSync(outside), [], "no 'exits' dir or .gitignore created inside the symlinked .herdr target");
  } finally {
    await t.teardown();
  }
});

test("exec writes .herdr/.gitignore defensively so exit drop files never surface in git status", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("pane.send_input", (p) => {
      const dir = join(cwd, ".herdr", "exits");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, idFrom((p as { text: string }).text)), "0\n");
      return { type: "ok" };
    });

    await runBrokerMethod(t.deps, "default", "broker.pane.exec", { pane_id: "w1:p1", command: "true" });
    assert.equal(readFileSync(join(cwd, ".herdr", ".gitignore"), "utf8"), "*\n");
  } finally {
    await t.teardown();
  }
});

test("exec does not clobber an existing .herdr/.gitignore", async () => {
  const t = await setup();
  try {
    const cwd = scratchRepo();
    mkdirSync(join(cwd, ".herdr"), { recursive: true });
    writeFileSync(join(cwd, ".herdr", ".gitignore"), "custom\n");
    t.deps.index.set("default", "w1", { cwd });
    t.fake.handlers.set("pane.send_input", (p) => {
      const dir = join(cwd, ".herdr", "exits");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, idFrom((p as { text: string }).text)), "0\n");
      return { type: "ok" };
    });

    await runBrokerMethod(t.deps, "default", "broker.pane.exec", { pane_id: "w1:p1", command: "true" });
    assert.equal(readFileSync(join(cwd, ".herdr", ".gitignore"), "utf8"), "custom\n");
  } finally {
    await t.teardown();
  }
});
