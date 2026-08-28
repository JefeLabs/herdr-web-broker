/** herdr exposes interactive_ready, which is more than tmux gives — but a
 * CLI can render its TUI and then die. Readiness is therefore a LEVEL to
 * hold across the settle window, not an edge to catch once. */
export function holdsReady(samples: Array<boolean | undefined>): boolean {
  return samples.length >= 2 && samples.every((s) => s === true);
}
