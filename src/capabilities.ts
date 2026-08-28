/** The capability names a module may declare and an operator may grant.
 *
 * These names are part of `abi: 1`. Renaming one breaks every module
 * declaring it, so the split is deliberately COARSE — per-method grants
 * would be ABI weight nobody uses.
 *
 * The rule for adding an eighth: SPLIT WHERE THE GUARANTEES DIFFER, NOT
 * WHERE THE VERBS DO. `git` splits read/write because the mutating verbs
 * are the audited, confirm-gated ones — a real change in blast radius.
 * `files` does not split, because both directions sit behind the same
 * realpathSync escape guard, so a split would name no actual difference. */
export const CAPABILITIES = [
  "git.read",
  "git.write",
  "files",
  "workspaces",
  "agents",
  "rpc",
  "events",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(x: unknown): x is Capability {
  return typeof x === "string" && (CAPABILITIES as readonly string[]).includes(x);
}

export interface GrantResult {
  /** in CAPABILITIES order, deduped — stable so logs and /admin/modules
   * read the same on every boot */
  granted: Capability[];
  /** every unrecognized name from EITHER side; the loader refuses the
   * module rather than dropping these */
  unknown: string[];
}

/** The grant is the intersection of what the module declares and what the
 * operator configured. Neither side alone can widen it: a greedy module
 * with a stingy config gets nothing, and vice versa.
 *
 * Unknown names are returned rather than ignored. An operator typo that
 * silently granted nothing would be a confusing outage; the loader turns
 * this into a refusal with the offending name in the message. */
export function resolveGrant(declared: readonly string[], configured: readonly string[]): GrantResult {
  const unknown = [...new Set([...declared, ...configured].filter((n) => !isCapability(n)))];
  const d = new Set(declared);
  const c = new Set(configured);
  const granted = CAPABILITIES.filter((cap) => d.has(cap) && c.has(cap));
  return { granted, unknown };
}
