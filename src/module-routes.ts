import type { RouteHandler } from "../packages/module/src/index.js";
import type { LoadedModule } from "./module-loader.js";

export interface RouteMatch {
  mod: LoadedModule;
  route: { method: string; path: string; handler: RouteHandler };
  params: Record<string, string>;
}

/** Module routes live under a reserved prefix:
 *
 *     /v1/modules/{module-id}/{route}
 *
 * so collision with a core route is impossible and a URL says plainly
 * which tier it belongs to. `parts` arrives already stripped of the `/v1`
 * segment by http.ts, exactly as core routes see it.
 *
 * Pure — no I/O, no deps — so the whole matcher is unit-testable. */
export function matchModuleRoute(
  loaded: LoadedModule[],
  method: string,
  parts: string[],
): RouteMatch | undefined {
  if (parts[0] !== "modules" || parts.length < 2) return undefined;

  const mod = loaded.find((m) => m.id === parts[1]);
  // A module that failed to load keeps its id but has no routes, so its
  // paths 404 rather than silently resolving somewhere else.
  if (!mod || mod.error) return undefined;

  const rest = parts.slice(2);
  for (const route of mod.routes) {
    if (route.method !== method) continue;
    const want = route.path.split("/").filter(Boolean);
    // Exact segment count: no prefix matching, so /a/b never answers /a.
    if (want.length !== rest.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      if (want[i].startsWith(":")) params[want[i].slice(1)] = rest[i];
      else if (want[i] !== rest[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { mod, route, params };
  }
  return undefined;
}
