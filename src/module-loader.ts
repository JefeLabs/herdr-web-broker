import { pathToFileURL } from "node:url";
import { BROKER_MODULE_ABI, type BrokerModule } from "../packages/module/src/index.js";
import type { BrokerEvents } from "./broker-events.js";
import { resolveGrant, type Capability } from "./capabilities.js";
import { buildApi, type RegisteredRoute } from "./module-api.js";
import type { OpsDeps } from "./workspace-ops.js";

export interface ModuleSpec {
  path: string;
  capabilities: string[];
}

export interface LoadContext {
  deps: OpsDeps;
  session: string;
  instance: string;
  events: BrokerEvents;
  log: (msg: string) => void;
  audit: { record(e: { action: string; actor: string; target?: string }): void };
}

export interface LoadedModule {
  id: string;
  path: string;
  granted: Capability[];
  routes: RegisteredRoute[];
  /** set when the module was refused; its routes are empty and 404 */
  error?: string;
}

/** Loads every configured module, containing each failure to that module.
 *
 * A module that fails leaves its routes 404 — visible — while the broker
 * boots. Refusing to start the whole broker because one optional
 * extension is broken would take the entire API down for it, against the
 * degrade-never-throw discipline the rest of this codebase follows.
 *
 * Boot-only by design: `config.toml` keeps hot-reloading `client_tokens`,
 * but re-importing a module mid-flight leaks whatever the old instance
 * closed over, and a route table changing under live requests is the
 * wrong trade for a feature whose whole appeal is predictability. */
export async function loadModules(specs: ModuleSpec[], ctx: LoadContext): Promise<LoadedModule[]> {
  const out: LoadedModule[] = [];
  const seen = new Set<string>();

  for (const spec of specs) {
    const fail = (id: string, error: string): void => {
      ctx.log(`[modules] refused ${spec.path}: ${error}`);
      out.push({ id, path: spec.path, granted: [], routes: [], error });
    };

    let mod: BrokerModule;
    try {
      const imported = (await import(pathToFileURL(spec.path).href)) as { default?: BrokerModule };
      if (!imported.default) throw new Error("module has no default export");
      mod = imported.default;
    } catch (e) {
      fail(spec.path, `import failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (typeof mod.id !== "string" || !mod.id) {
      fail(spec.path, "module has no string 'id'");
      continue;
    }
    if (mod.abi !== BROKER_MODULE_ABI) {
      // Both numbers in the message: a version mismatch should never
      // present as a mysterious missing method.
      fail(mod.id, `abi ${mod.abi} does not match this broker's abi ${BROKER_MODULE_ABI}`);
      continue;
    }
    if (seen.has(mod.id)) {
      fail(mod.id, `duplicate module id '${mod.id}' — the first one loaded wins`);
      continue;
    }

    const { granted, unknown } = resolveGrant(mod.capabilities ?? [], spec.capabilities);
    if (unknown.length > 0) {
      // An operator typo that silently granted nothing would be a
      // confusing outage; name it instead.
      fail(mod.id, `unknown capability name(s): ${unknown.join(", ")}`);
      continue;
    }

    const built = buildApi({
      moduleId: mod.id,
      granted,
      deps: ctx.deps,
      session: ctx.session,
      instance: ctx.instance,
      events: ctx.events,
      log: ctx.log,
      audit: ctx.audit,
    });
    try {
      mod.register(built.api);
    } catch (e) {
      fail(mod.id, `register() threw: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    seen.add(mod.id);
    out.push({ id: mod.id, path: spec.path, granted, routes: built.routes });
  }
  return out;
}
