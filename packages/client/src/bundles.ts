import type { SessionHandle } from "./client.js";
import type { Bundle, BundleSummary } from "./types.js";

export interface FollowOpts {
  waitMs?: number;
  onError?: (e: unknown) => void;
}

export class BundleScope {
  constructor(
    private readonly session: SessionHandle,
    readonly workspaceId: string,
  ) {}

  list(): Promise<BundleSummary[]> {
    throw new Error("not implemented");
  }

  get(bundle: string): Promise<Bundle> {
    throw new Error("not implemented");
  }

  follow(bundle: string, cb: (b: Bundle) => void, opts: FollowOpts = {}): () => void {
    throw new Error("not implemented");
  }
}
