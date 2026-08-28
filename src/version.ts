export const PLUGIN_VERSION = "0.1.0";

/** The API's version segment. Routes are served BOTH at `/v1/...` and at
 * the bare unversioned path — the bare form is a deprecated alias kept so
 * pre-1.0 clients keep working, and goes away at 1.0. Everything the SDK
 * emits carries the prefix; only the matcher strips it. */
export const API_VERSION = "v1";

/** herdr versions this broker is tested against.
 *
 * Correctness rests on wire behaviors herdr does not document — one-shot
 * RPC sockets, subscribe-only channels that accept exactly one subscribe,
 * pane_id-required status subscriptions, and mixed dotted/underscored
 * event-name spellings. None of that is guaranteed to survive a herdr
 * minor bump, and the weekly drift canary only protects CI: it does
 * nothing for a user who upgrades herdr underneath a running broker.
 *
 * Keep MIN in sync with herdr-plugin.toml's `min_herdr_version`. */
export const MIN_HERDR_VERSION = "0.8.0";

/** The highest herdr MINOR line whose wire behavior has actually been
 * probed. Above this the broker warns and continues — see verdictFor. */
export const MAX_TESTED_HERDR_MINOR = "0.8";

/** Parses a leading `major.minor.patch` out of whatever `herdr --version`
 * prints — it may carry a `v` prefix, a name, or build metadata. Returns
 * undefined when no version-looking triple is present, which the caller
 * treats as "unknown", not as zero. */
export function parseVersion(raw: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** -1 / 0 / 1, comparing major then minor then patch. */
export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export type HerdrVerdict =
  | { ok: true }
  | { ok: true; warn: string }
  | { ok: false; refuse: string };

/** The startup gate, as a pure function so the policy is testable without
 * spawning herdr or booting a daemon.
 *
 * The asymmetry is deliberate. BELOW the floor is known-incompatible, so
 * the broker refuses rather than failing in confusing ways later. ABOVE
 * the tested ceiling is merely UNKNOWN — it may work perfectly — so it
 * warns and continues; refusing there would turn a possibly-working setup
 * into a guaranteed outage on every herdr upgrade, which is exactly the
 * degrade-never-throw discipline the rest of this codebase follows. An
 * unparseable version warns for the same reason. */
export function verdictFor(rawVersion: string): HerdrVerdict {
  const found = parseVersion(rawVersion);
  if (!found) {
    return {
      ok: true,
      warn:
        `could not read a version from herdr (\`${rawVersion}\`) — this broker is tested against ` +
        `herdr ${MIN_HERDR_VERSION}–${MAX_TESTED_HERDR_MINOR}.x and is proceeding unverified`,
    };
  }
  const min = parseVersion(MIN_HERDR_VERSION)!;
  if (compareVersions(found, min) < 0) {
    return {
      ok: false,
      refuse:
        `herdr ${found.join(".")} is older than the minimum this broker supports ` +
        `(${MIN_HERDR_VERSION}) — refusing to start rather than failing later in ways that look like bugs`,
    };
  }
  const ceiling = parseVersion(MAX_TESTED_HERDR_MINOR)!;
  // Compare on major.minor only: 0.8.7 is inside a tested 0.8 line.
  if (compareVersions([found[0], found[1], 0], [ceiling[0], ceiling[1], 0]) > 0) {
    return {
      ok: true,
      warn:
        `herdr ${found.join(".")} is NEWER than the newest line this broker has been probed against ` +
        `(${MAX_TESTED_HERDR_MINOR}.x). Correctness here rests on undocumented herdr wire behavior, so ` +
        `treat any odd RPC, subscription, or event-name failure as a compatibility break, not a broker bug`,
    };
  }
  return { ok: true };
}
