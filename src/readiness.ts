/** herdr exposes interactive_ready, which is more than tmux gives — but a
 * CLI can render its TUI and then die. Readiness is therefore treated as a
 * LEVEL to hold across a settle window, not an edge to catch once.
 *
 * The level property comes from the CALLER repeatedly sampling across that
 * window (see spawn()'s settle loop in workspace-ops.ts) — not from this
 * predicate. This predicate's only job is: did any sample ever prove the
 * pane had stopped being ready? An `undefined` sample (herdr never reports
 * the field) is not proof of anything and must not fail the hold — a
 * herdr that omits interactive_ready has to spawn exactly as it did
 * before this existed. */
export function holdsReady(samples: Array<boolean | undefined>): boolean {
  return !samples.some((s) => s === false);
}
