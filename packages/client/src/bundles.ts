import type { SessionHandle } from "./client.js";
import { request } from "./http.js";
import type { Bundle, BundleSummary } from "./types.js";

const enc = encodeURIComponent;

export interface FollowOpts {
  /** long-poll window per request (server caps at 30s) */
  waitMs?: number;
  onError?: (e: unknown) => void;
}

export class BundleScope {
  constructor(
    private readonly session: SessionHandle,
    readonly workspaceId: string,
  ) {}

  #base(): string {
    return `${this.session.base()}/workspaces/${enc(this.workspaceId)}/spec-bundles`;
  }

  async list(): Promise<BundleSummary[]> {
    const r = await request<{ bundles: BundleSummary[] }>(this.session.cfg, "GET", this.#base());
    return r.bundles;
  }

  get(bundle: string): Promise<Bundle> {
    return request(this.session.cfg, "GET", `${this.#base()}/${enc(bundle)}`);
  }

  /** Managed long-poll loop: one request in flight, version threading, and
   * exponential backoff (1s → 30s, reset on success). The server does the
   * waiting — a reply arrives the moment the agent saves. Returns an
   * unsubscribe that stops the loop. */
  follow(bundle: string, cb: (b: Bundle) => void, opts: FollowOpts = {}): () => void {
    const waitMs = opts.waitMs ?? 25_000;
    let stopped = false;
    let version: string | undefined;
    let backoff = 1_000;
    const run = async () => {
      while (!stopped) {
        try {
          const reply = await request<Bundle | { unchanged: true; version: string }>(
            this.session.cfg,
            "GET",
            `${this.#base()}/${enc(bundle)}`,
            version
              ? { query: { version, wait_ms: String(waitMs) }, timeoutMs: waitMs + 15_000 }
              : {},
          );
          backoff = 1_000;
          if (stopped) return;
          if ((reply as { unchanged?: boolean }).unchanged) {
            version = (reply as { version: string }).version;
            continue;
          }
          version = (reply as Bundle).version;
          cb(reply as Bundle);
        } catch (e) {
          if (stopped) return;
          opts.onError?.(e);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    };
    void run();
    return () => {
      stopped = true;
    };
  }
}
