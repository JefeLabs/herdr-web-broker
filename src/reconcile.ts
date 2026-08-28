import type { WorkspaceMeta } from "./state.js";

export interface Classification {
  /** indexed AND live — the broker's own, safe to operate on */
  adopt: string[];
  /** indexed but gone from herdr — stale index rows to drop */
  forget: string[];
  /** live but never indexed — someone else's work. REPORTED, NEVER REAPED. */
  orphans: string[];
}

/** Pure adopt/forget/orphan policy, separated from all I/O so restart
 * behavior is testable without a runtime.
 *
 * The discipline that matters: a live workspace the broker has no record of
 * is an ORPHAN, not garbage. This function only classifies — it never
 * decides what a caller does with the classification. Callers that use it
 * for pure reporting (e.g. the `broker.session.orphans` surface) must
 * report orphans and leave them running; callers that use it for other
 * purposes (e.g. session teardown, which is already killing the whole herdr
 * process regardless of what any individual workspace is) may make a
 * different, explicit call about `orphans` — but that call belongs to the
 * caller, not to this function. What this function guarantees is that
 * `orphans` is never silently folded into `forget`: the two are always
 * distinguishable to whoever reads the result. */
export function classifySession(known: Record<string, WorkspaceMeta>, live: string[]): Classification {
  const liveSet = new Set(live);
  const knownIds = Object.keys(known);
  return {
    adopt: knownIds.filter((id) => liveSet.has(id)),
    forget: knownIds.filter((id) => !liveSet.has(id)),
    orphans: live.filter((id) => !(id in known)),
  };
}
