import test from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry } from "../src/model-registry.js";

test("builtin catalog: known kinds ship models with attributes", () => {
  const reg = new ModelRegistry();
  const copilot = reg.list("copilot");
  assert.ok(copilot.length > 0, "copilot has builtin models");
  for (const m of copilot) {
    assert.equal(m.kind, "copilot");
    assert.equal(m.source, "builtin");
    assert.ok(typeof m.context_window === "number" && m.context_window > 0, `${m.id} carries a context window`);
  }
  assert.ok(reg.list("claude").some((m) => m.id === "sonnet"));
});

test("list without kind returns every kind; unknown kind returns empty", () => {
  const reg = new ModelRegistry();
  const kinds = new Set(reg.list().map((m) => m.kind));
  assert.ok(kinds.has("copilot") && kinds.has("claude") && kinds.has("codex"));
  assert.deepEqual(reg.list("no-such-cli"), []);
});

test("config rows extend the catalog and override builtins by kind+id", () => {
  const reg = new ModelRegistry({
    catalog: [
      { kind: "copilot", id: "gpt-5", label: "Tuned GPT-5", context_window: 999 },
      { kind: "aider", id: "deepseek-v3", context_window: 128000 },
    ],
  });
  const gpt5 = reg.find("copilot", "gpt-5");
  assert.equal(gpt5?.label, "Tuned GPT-5");
  assert.equal(gpt5?.context_window, 999);
  assert.equal(gpt5?.source, "config");
  assert.equal(reg.list("copilot").filter((m) => m.id === "gpt-5").length, 1, "override replaces, not duplicates");
  assert.equal(reg.find("aider", "deepseek-v3")?.source, "config");
});

test("switchCommand renders the kind's template with the model", () => {
  const reg = new ModelRegistry();
  assert.equal(reg.switchCommand("claude", "opus"), "/model opus");
  assert.equal(reg.switchCommand("copilot", "gpt-5"), "/model gpt-5");
});

test("switchCommand: config template overrides builtin; unknown kind has none", () => {
  const reg = new ModelRegistry({ switch: [{ kind: "copilot", template: "/set-model {model} --now" }] });
  assert.equal(reg.switchCommand("copilot", "gpt-5"), "/set-model gpt-5 --now");
  assert.equal(new ModelRegistry().switchCommand("no-such-cli", "x"), undefined);
});
