/** herdr exposes interactive_ready, which is more than tmux gives — but a
 * CLI can render its TUI and then die. Readiness is therefore treated as a
 * LEVEL to hold across a settle window, not an edge to catch once.
 *
 * The level property comes from the CALLER repeatedly sampling across that
 * window (see spawn()'s settle loop in workspace-ops.ts) — not from this
 * predicate. This predicate's only job is: did a sample ever prove the
 * pane WAS ready and then stopped being ready? A `false` that never
 * follows a `true` is not that — sample i=0 is taken immediately after
 * agent.start, while herdr can still be in its normal launch_pending
 * phase, so a `false` there is a slow-but-healthy start, not a death. An
 * `undefined` sample (herdr never reports the field) is not proof of
 * anything either and must not fail the hold — a herdr that omits
 * interactive_ready has to spawn exactly as it did before this existed. */
export function holdsReady(samples: Array<boolean | undefined>): boolean {
  let wasReady = false;
  for (const s of samples) {
    if (s === true) wasReady = true;
    else if (s === false && wasReady) return false;
  }
  return true;
}
