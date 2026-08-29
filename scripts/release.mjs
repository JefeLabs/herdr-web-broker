#!/usr/bin/env node
// Release driver: preflight every publishable workspace against the registry,
// then publish in dependency order — or publish nothing at all.
//
// The hazard this exists to kill: `npm publish -w a && npm publish -w b && ...`
// fails in the MIDDLE. Package a ships, b hits a version conflict, and you are
// left with a half-released version that npm will never let you re-use — the
// only way out is a version bump. Preflight turns that into a clean abort
// before the first byte leaves the machine.
//
//   node scripts/release.mjs              # preflight, then publish
//   node scripts/release.mjs --check-only # preflight only, publish nothing (CI gate)
//   node scripts/release.mjs --resume     # skip already-published, publish the rest
//   node scripts/release.mjs --dry-run    # full run, but npm publish --dry-run
//
// Registry reads use ?write=true deliberately. Plain GETs to registry.npmjs.org
// are CDN-cached, and a just-published package reads back as 404 for a minute
// or two afterwards. A preflight built on the cached view would call a taken
// version "free" and publish straight into the conflict it exists to prevent.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REGISTRY = "https://registry.npmjs.org";

/**
 * @typedef {object} PkgState
 * @property {string} name     npm name, e.g. "@jefelabs/herdr-broker-client"
 * @property {string} dir      workspace dir relative to root, e.g. "packages/client"
 * @property {string} version  local version, e.g. "0.2.0"
 * @property {Record<string,string>} deps  intra-workspace deps (name -> range)
 * @property {"free"|"taken"|"error"} [status]  filled in by preflight
 * @property {string} [detail] for status "error": why the lookup failed
 */

// ---------------------------------------------------------------- discovery

/**
 * Every publishable workspace under packages/*: has a package.json, and is not
 * marked private. Derived, never hardcoded — a hardcoded list is exactly how
 * packages/module got left out of the publish chain until bae7fd5.
 *
 * @param {string} rootDir repo root
 * @returns {PkgState[]}
 */
export function discoverPackages(rootDir) {
  const pkgsDir = join(rootDir, "packages");
  const out = [];
  for (const entry of readdirSync(pkgsDir).sort()) {
    const manifest = join(pkgsDir, entry, "package.json");
    if (!existsSync(manifest)) continue; // e.g. packages/demo-copilot
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.private === true) continue;
    if (!pkg.name || !pkg.version) continue;
    out.push({
      name: pkg.name,
      dir: `packages/${entry}`,
      version: pkg.version,
      deps: { ...pkg.dependencies },
    });
  }
  return out;
}

// ---------------------------------------------------------------- ordering

/**
 * Stable topological sort: a package is emitted only once every dependency it
 * has *within this set* has been emitted. Order is otherwise input order, so
 * the result is deterministic.
 *
 * @param {PkgState[]} packages
 * @returns {PkgState[]}
 */
export function orderByDependencies(packages) {
  const inSet = new Set(packages.map((p) => p.name));
  const emitted = new Set();
  const out = [];
  let remaining = [...packages];
  while (remaining.length > 0) {
    const ready = remaining.filter((p) =>
      Object.keys(p.deps ?? {}).every((d) => !inSet.has(d) || emitted.has(d)),
    );
    if (ready.length === 0) {
      throw new Error(
        `dependency cycle among workspaces: ${remaining.map((p) => p.name).join(", ")}`,
      );
    }
    for (const p of ready) {
      out.push(p);
      emitted.add(p.name);
    }
    remaining = remaining.filter((p) => !emitted.has(p.name));
  }
  return out;
}

// ---------------------------------------------------------------- preflight

/**
 * Turn one registry lookup into a status. A non-200/404 answer, or a thrown
 * fetch, is "error" — NEVER "free". Treating an outage as permission to publish
 * is how a safety check becomes the thing that breaks the release.
 *
 * @param {{status?: number, body?: any, error?: Error}} res
 * @param {string} version
 * @returns {{status: "free"|"taken"|"error", detail?: string}}
 */
export function classifyLookup(res, version) {
  if (res.error) return { status: "error", detail: res.error.message };
  if (res.status === 404) return { status: "free" };
  if (res.status !== 200) {
    return { status: "error", detail: `registry returned HTTP ${res.status}` };
  }
  const versions = res.body?.versions ?? {};
  if (Object.hasOwn(versions, version)) {
    const when = res.body?.time?.[version];
    return { status: "taken", detail: when ? `published ${when.slice(0, 10)}` : "already published" };
  }
  return { status: "free" };
}

/** Origin read, bypassing the CDN. @param {string} name */
async function lookup(name) {
  const url = `${REGISTRY}/${name.replace("/", "%2F")}?write=true`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const body = res.status === 200 ? await res.json() : null;
    return { status: res.status, body };
  } catch (error) {
    return { error };
  }
}

// ---------------------------------------------------------------- the policy

/**
 * Decide what this release does. THE POLICY LIVES HERE — everything else is
 * plumbing.
 *
 * Rules (see scripts/release.test.mjs for the exact expectations):
 *   - Any package whose lookup errored aborts the run, even under --resume.
 *     An unknown registry state is never safe to publish into.
 *   - Any taken version aborts the run, unless resume is set.
 *   - Under resume, taken packages are dropped and the rest publish.
 *   - If resume leaves nothing to publish, that is an abort too — a release
 *     that publishes zero packages should say so, not exit 0 pretending.
 *   - Otherwise: publish, preserving the order of `packages`.
 *
 * `reason` is shown to the human on abort. Make it say what to do next.
 *
 * @param {PkgState[]} packages in dependency order, each with .status set
 * @param {{resume?: boolean}} [opts]
 * @returns {{action:"publish"|"abort", publish:PkgState[], taken:PkgState[], errors:PkgState[], reason?:string}}
 */
export function planRelease(packages, opts = {}) {
  const resume = opts.resume === true;
  const errors = packages.filter((p) => p.status === "error");
  const taken = packages.filter((p) => p.status === "taken");
  const free = packages.filter((p) => p.status === "free");
  const abort = (reason) => ({ action: "abort", publish: [], taken, errors, reason });
  const describe = (list) => list.map((p) => `${p.name}@${p.version}`).join(", ");

  // Checked before `taken`, and deliberately not rescued by --resume: a failed
  // lookup means we do not KNOW whether the version is free. Skipping it would
  // publish blind into exactly the conflict this preflight exists to prevent.
  if (errors.length > 0) {
    return abort(
      `could not determine registry state for ${describe(errors)}. ` +
        `Refusing to publish into an unknown state — re-run when the registry is reachable.`,
    );
  }

  if (taken.length > 0 && !resume) {
    // Only offer --resume when it would actually do something. Suggesting it
    // with nothing free sends the reader to a second, identical abort.
    const wayOut =
      free.length > 0
        ? `Bump the version(s), or re-run with --resume to publish only the remaining ${free.length}.`
        : `Bump the version(s) to ship again.`;
    return abort(
      `${taken.length} of ${packages.length} version(s) already published: ${describe(taken)}. ${wayOut}`,
    );
  }

  // Reachable only under --resume, once every version turned out to be taken.
  // Returning "publish" with an empty list here would exit 0 and report a
  // successful release that shipped nothing.
  if (free.length === 0) {
    return abort(
      `every version is already published (${describe(taken)}) — nothing left to publish. ` +
        `Bump the version(s) to ship again.`,
    );
  }

  return { action: "publish", publish: free, taken, errors };
}

// ---------------------------------------------------------------- publishing

/**
 * Publish each planned package in order, stopping at the first failure and
 * reporting exactly what did and did not ship — a partial failure has to end
 * with an actionable summary, not a bare exit code.
 *
 * @param {PkgState[]} toPublish
 * @param {{dryRun?: boolean, run?: (dir: string, dryRun: boolean) => {ok: boolean, detail?: string}}} [opts]
 * @returns {{published: string[], failed: string|null, skipped: string[], detail?: string}}
 */
export function publishAll(toPublish, opts = {}) {
  const run = opts.run ?? defaultRun;
  const published = [];
  for (let i = 0; i < toPublish.length; i++) {
    const pkg = toPublish[i];
    const result = run(pkg.dir, opts.dryRun === true);
    if (!result.ok) {
      return {
        published,
        failed: pkg.name,
        skipped: toPublish.slice(i + 1).map((p) => p.name),
        detail: result.detail,
      };
    }
    published.push(pkg.name);
  }
  return { published, failed: null, skipped: [] };
}

function defaultRun(dir, dryRun) {
  const args = ["publish", "-w", dir, "--access", "public"];
  if (dryRun) args.push("--dry-run");
  const res = spawnSync("npm", args, { stdio: "inherit" });
  return { ok: res.status === 0, detail: `npm publish exited ${res.status}` };
}

// ---------------------------------------------------------------- cli

async function main(argv) {
  const flags = new Set(argv);
  const checkOnly = flags.has("--check-only");
  const resume = flags.has("--resume");
  const dryRun = flags.has("--dry-run");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  const packages = orderByDependencies(discoverPackages(root));
  if (packages.length === 0) {
    console.error("no publishable workspaces found under packages/*");
    return 1;
  }

  for (const pkg of packages) {
    const { status, detail } = classifyLookup(await lookup(pkg.name), pkg.version);
    pkg.status = status;
    pkg.detail = detail;
    const mark = { free: "ok   ", taken: "TAKEN", error: "ERROR" }[status];
    console.log(`[${mark}] ${pkg.name}@${pkg.version}${detail ? ` — ${detail}` : ""}`);
  }

  const plan = planRelease(packages, { resume });
  console.log("");

  if (plan.action === "abort") {
    console.error(`ABORT: ${plan.reason}`);
    console.error("(nothing published)");
    return 1;
  }

  if (checkOnly) {
    console.log(`preflight ok — ${plan.publish.length} package(s) ready to publish`);
    return 0;
  }

  console.log(`publishing ${plan.publish.length} package(s)${dryRun ? " (dry run)" : ""}...`);
  const result = publishAll(plan.publish, { dryRun });
  console.log("");
  if (result.failed) {
    console.error(`FAILED publishing ${result.failed}${result.detail ? ` — ${result.detail}` : ""}`);
    if (result.published.length > 0) {
      console.error(`already published this run: ${result.published.join(", ")}`);
      console.error(`NOT published: ${[result.failed, ...result.skipped].join(", ")}`);
      console.error("re-run with --resume once the cause is fixed.");
    }
    return 1;
  }
  const verb = dryRun ? "would publish" : "published";
  console.log(`${verb}: ${result.published.join(", ")}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err?.stack ?? err);
      process.exit(1);
    });
}
