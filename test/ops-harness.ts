import { join } from "node:path";
import { EnvRegistry } from "../src/env-registry.js";
import { LocalHerdr } from "../src/local-attach.js";
import { ModelRegistry } from "../src/model-registry.js";
import { Registry } from "../src/registry.js";
import { AgentIndex, WorkspaceIndex } from "../src/state.js";
import { CliProfiles } from "../src/cli-profiles.js";
import type { OpsDeps } from "../src/workspace-ops.js";
import { FakeHerdr } from "./fake-herdr.js";
import { tmpDir } from "./util.js";

export async function setup(): Promise<{ fake: FakeHerdr; deps: OpsDeps; teardown: () => Promise<void> }> {
  const fake = new FakeHerdr(join(tmpDir(), "h.sock"));
  fake.agents = [{ pane_id: "w1:p1", name: "copilot", agent: "copilot", agent_status: "working" }];
  await fake.listen();
  const registry = new Registry();
  const local = new LocalHerdr({
    registry,
    herdrVersion: "0.8.0-test",
    endpoints: [{ session: "default", socketPath: fake.socketPath }],
  });
  await local.start();
  // Mirror daemon.ts: the registry entry for "runtime" must exist or
  // applyAgentStatus is a silent no-op (the ask early-exit test drives
  // pane status through the registry exactly the way SessionEvents does).
  registry.replaceSnapshot("runtime", await local.snapshot());
  const deps: OpsDeps = {
    local,
    registry,
    index: new WorkspaceIndex(tmpDir()),
    env: new EnvRegistry({ stateDir: tmpDir() }),
    models: new ModelRegistry(),
    agents: new AgentIndex(tmpDir()),
    profiles: new CliProfiles(),
    stateDir: tmpDir(),
    askPollMs: 25,
    askGraceMs: 150,
    // The readiness sentinel is exercised by spawn-readiness.test.ts and
    // workspace-ops.test.ts explicitly. Off here so the existing spawn call
    // sites don't each pay a FakeHerdr round trip they aren't testing.
    readinessTimeoutMs: 0,
    paneBusyDelayMs: 5,
    settleMsOverride: 0,
  };
  return {
    fake,
    deps,
    teardown: async () => {
      local.stop();
      await fake.close();
    },
  };
}
