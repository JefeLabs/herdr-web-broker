import { BrokerApiError, type BrokerClient, type DiffResult, type TreeNode, type Workspace } from "@jefelabs/herdr-broker-client";
import { useCallback, useMemo, useState } from "react";
import { useBrokerOr } from "./context.js";
import { useWorkspaces } from "./useLists.js";

const describe = (e: unknown) =>
  e instanceof BrokerApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);

/** Workspace/repo browsing behavior: on-demand workspace roster (via
 * useWorkspaces auto:false), and per-repo browse() fetching the git-index
 * file tree and the diff against an optional base ref in one go. Skins
 * render the cards, trees, and diffs; this fetches them. Extracted from
 * the WorkspaceBrowser organism, which now consumes it. */
export function useRepoBrowser(
  opts: { instance: string; session: string },
  brokerArg?: BrokerClient,
): {
  workspaces: Workspace[];
  loaded: boolean;
  busy: boolean;
  loadError: string | null;
  load: () => Promise<void>;
  selected: { ws: string; repo: string } | null;
  tree: { tree: TreeNode; truncated: boolean } | null;
  diff: DiffResult | null;
  base: string;
  setBase: (ref: string) => void;
  browseError: string | null;
  browse: (ws: string, repoPath: string, baseRef?: string) => Promise<void>;
} {
  const broker = useBrokerOr(brokerArg);
  const session = useMemo(
    () => broker.instance(opts.instance).session(opts.session),
    [broker, opts.instance, opts.session],
  );

  const { workspaces, error: loadError, loaded, reload } = useWorkspaces(
    { instance: opts.instance, session: opts.session, auto: false },
    broker,
  );
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ ws: string; repo: string } | null>(null);
  const [tree, setTree] = useState<{ tree: TreeNode; truncated: boolean } | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [base, setBase] = useState("");
  const [browseError, setBrowseError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setSelected(null);
    setTree(null);
    setDiff(null);
    await reload();
    setBusy(false);
  }, [reload]);

  const browse = useCallback(
    async (ws: string, repoPath: string, baseRef?: string) => {
      const ref = baseRef ?? base;
      setSelected({ ws, repo: repoPath });
      setTree(null);
      setDiff(null);
      setBrowseError(null);
      const repo = session.repo(ws, repoPath);
      const [t, d] = await Promise.allSettled([repo.tree(), repo.diff(ref.trim() || undefined)]);
      if (t.status === "fulfilled") setTree(t.value);
      else setBrowseError(describe(t.reason));
      if (d.status === "fulfilled") setDiff(d.value);
      else setBrowseError((prev) => prev ?? describe(d.reason));
    },
    [session, base],
  );

  return { workspaces, loaded, busy, loadError, load, selected, tree, diff, base, setBase, browseError, browse };
}
