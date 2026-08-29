import { randomUUID } from "node:crypto";

/** Spawn readiness — prove the shell is at its prompt, don't guess.
 * Spec: docs/superpowers/specs/2026-08-28-spawn-readiness-design.md
 *
 * `agent.start` on a pane whose login shell has not reached its prompt is
 * refused with `agent_pane_busy`. That is a race, not an error: the same call
 * a second later always works. The broker absorbed it with a retry, which
 * means paying up to ~4s of timeout on every cold pane instead of asking a
 * question.
 *
 * The question is askable. Push a sentinel through the PTY and wait for it to
 * come back: when it echoes, the shell is provably at its prompt AND executing
 * commands. No prompt-pattern matching, no shell detection, no fixed sleep —
 * it works the same for zsh, bash, fish and any prompt framework, because it
 * tests the property that matters rather than a proxy for it.
 *
 * WT-7 (2026-08-29, live herdr 0.8.2) established the fact this rests on:
 * `pane.wait_for_output` matches the pane's OWN echoed input, returning
 * `matched_line` as the echoed command itself, on `visible` AND `recent`. */

/** Just the LocalHerdr surface this needs, so the policy is testable with a
 * stub instead of a daemon. `OpsDeps` satisfies it structurally. */
export interface ReadinessDeps {
  local: {
    request(session: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  };
  /** ms to wait for the sentinel; 0 disables it. Default 5000. */
  readinessTimeoutMs?: number;
}

export interface ReadinessOpts {
  /** A command to run BEFORE the sentinel, on the same line — the env
   * drop-file path passes `. <drop>; rm -f <drop>` here. The shell runs them
   * sequentially, so the sentinel cannot echo before the prefix completes,
   * which is what makes "env is sourced" and "shell is ready" one round trip
   * instead of two. */
  prefix?: string;
  /** Env injection failing is a real error the caller must surface; the
   * sentinel failing is not. Both share a send, so the caller says which it
   * is. */
  throwOnSendFailure?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** The command to send and the string to await. Pure, so the agreement
 * between the two is testable without a pane.
 *
 * The per-spawn random id is load-bearing: `pane.split` reuses a workspace,
 * so a pane can already hold a previous spawn's sentinel line. A fixed marker
 * would match that stale echo and declare a cold shell ready — wrong on
 * exactly the path that is hardest to test. */
export function readinessSentinel(): { text: string; match: string } {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  const match = `__herdr_ready_${id}__`;
  return { text: `printf '${match}\\n'`, match };
}

/** Send the sentinel (optionally behind `prefix`) and wait for its echo.
 *
 * Returns whether the shell proved ready. NEVER throws for a readiness
 * failure — this is best-effort by design: a check that can block a spawn is
 * a new failure mode, and the `agent_pane_busy` retry remains the floor. The
 * one exception is a send failure with `throwOnSendFailure`, because that
 * send also carries the caller's env injection. */
export async function awaitShellReady(
  deps: ReadinessDeps,
  session: string,
  paneId: string,
  opts: ReadinessOpts = {},
): Promise<boolean> {
  const timeoutMs = deps.readinessTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const send = (text: string) =>
    deps.local.request(session, "pane.send_input", { pane_id: paneId, text, keys: ["Enter"] }, 10_000);

  // Disabled: the sentinel goes away, the prefix does NOT. Turning readiness
  // off must never turn env injection off with it.
  if (timeoutMs <= 0) {
    if (opts.prefix !== undefined) {
      try {
        await send(opts.prefix);
      } catch (e) {
        if (opts.throwOnSendFailure) throw e;
      }
    }
    return false;
  }

  const sentinel = readinessSentinel();
  const line = opts.prefix !== undefined ? `${opts.prefix}; ${sentinel.text}` : sentinel.text;

  try {
    await send(line);
  } catch (e) {
    if (opts.throwOnSendFailure) throw e;
    return false;
  }

  try {
    await deps.local.request(
      session,
      "pane.wait_for_output",
      {
        pane_id: paneId,
        // `visible` is the live screen and the sentinel is the newest line.
        // WT-7 confirmed `recent` matches too, so scrollback is a fallback
        // available if a future path can push the marker off-screen.
        source: "visible",
        match: { type: "substring", value: sentinel.match },
        timeout_ms: timeoutMs,
      },
      timeoutMs + 5000,
    );
    return true;
  } catch {
    // Timed out or refused — the retry loop downstream still covers it.
    return false;
  }
}
