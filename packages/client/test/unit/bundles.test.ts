import { afterEach, describe, expect, test, vi } from "vitest";
import { BrokerClient } from "../../src/client.js";
import type { Bundle } from "../../src/types.js";

type Reply = { status: number; body: string } | "network-error" | "pend";

function scripted(replies: Reply[]) {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => {
    const r = replies[Math.min(calls.length, replies.length - 1)];
    calls.push(String(url));
    if (r === "pend") return new Promise<Response>(() => undefined);
    if (r === "network-error") throw new TypeError("fetch failed");
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const scopeOf = (fetchFn: typeof fetch) =>
  new BrokerClient({ origin: "", token: "t", fetchFn }).instance("runtime").session("default").bundles("w1");

const bundleJson = (version: string) =>
  JSON.stringify({
    workspace_id: "w1",
    bundle: "2026-08-20-x",
    dir: "docs/superpowers/specs/2026-08-20-x",
    version,
    files: { "overview.md": { content: `v ${version}`, size: 4 } },
  });

afterEach(() => vi.useRealTimers());

describe("BundleScope", () => {
  test("list and get hit the documented paths", async () => {
    const { calls, fetchFn } = scripted([{ status: 200, body: '{"bundles":[{"bundle":"b","files":[]}]}' }]);
    const scope = scopeOf(fetchFn);
    const bundles = await scope.list();
    expect(bundles[0].bundle).toBe("b");
    expect(calls[0]).toBe("/parent/runtime/sessions/default/workspaces/w1/spec-bundles");
  });

  test("follow threads versions, skips unchanged, delivers on change, and stops on unsubscribe", async () => {
    const { calls, fetchFn } = scripted([
      { status: 200, body: bundleJson("v1") },
      { status: 200, body: '{"unchanged":true,"version":"v1"}' },
      { status: 200, body: bundleJson("v2") },
      "pend",
    ]);
    const seen: string[] = [];
    const stop = scopeOf(fetchFn).follow("2026-08-20-x", (b: Bundle) => seen.push(b.version), { waitMs: 25000 });
    await vi.waitFor(() => expect(seen).toEqual(["v1", "v2"]));
    expect(calls[0]).not.toContain("version=");
    expect(calls[1]).toContain("version=v1");
    expect(calls[1]).toContain("wait_ms=25000");
    expect(calls[3]).toContain("version=v2");
    stop();
    expect(calls.length).toBe(4);
  });

  test("follow backs off on errors and recovers", async () => {
    vi.useFakeTimers();
    const { fetchFn } = scripted(["network-error", { status: 200, body: bundleJson("v1") }, "pend"]);
    const seen: string[] = [];
    const errors: unknown[] = [];
    const stop = scopeOf(fetchFn).follow("2026-08-20-x", (b: Bundle) => seen.push(b.version), {
      onError: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.length).toBe(1);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000); // first backoff step
    expect(seen).toEqual(["v1"]);
    stop();
  });
});
