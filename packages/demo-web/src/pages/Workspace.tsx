import { BrokerApiError, type DiffResult, type TreeNode, type Workspace } from "@jefelabs/herdr-broker-client";
import { useState } from "react";
import { DiffView } from "../components/ui";
import { useSettings } from "../settings";

const describe = (e: unknown) =>
  e instanceof BrokerApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);

/** Dedicated demo: one workspace, n repos — roster, file trees straight from
 * git's index, diffs against any base. This page consumes the
 * @jefelabs/herdr-broker-client SDK (session/repo handles), not raw fetches. */
export function WorkspaceBrowser() {
  const settings = useSettings();
  const session = settings.broker.instance(settings.instance).session(settings.session);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ ws: string; repo: string } | null>(null);
  const [tree, setTree] = useState<{ tree: TreeNode; truncated: boolean } | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [base, setBase] = useState("");
  const [paneError, setPaneError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setSelected(null);
    setTree(null);
    setDiff(null);
    setLoadError(null);
    try {
      setWorkspaces(await session.workspaces());
    } catch (e) {
      setWorkspaces([]);
      setLoadError(describe(e));
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  }

  async function browse(ws: string, repoPath: string, baseRef = base) {
    setSelected({ ws, repo: repoPath });
    setTree(null);
    setDiff(null);
    setPaneError(null);
    const repo = session.repo(ws, repoPath);
    const [t, d] = await Promise.allSettled([repo.tree(), repo.diff(baseRef.trim() || undefined)]);
    if (t.status === "fulfilled") setTree(t.value);
    else setPaneError(describe(t.reason));
    if (d.status === "fulfilled") setDiff(d.value);
    else setPaneError((prev) => prev ?? describe(d.reason));
  }

  return (
    <div className="page">
      <h1 style={{ fontFamily: "var(--display)", letterSpacing: "0.06em" }}>Workspace browser</h1>
      <p className="note" style={{ maxWidth: "46rem" }}>
        A working set is a directory plus the team running in it. The broker discovers every git repo in the
        workspace (depth ≤ 2, never node_modules), serves each repo's file tree from git's own index, and diffs
        against any ref — this whole page is three GET endpoints.
      </p>
      <div className="ws-pickers">
        <label className="field">
          <span>instance</span>
          <input value={settings.instance} onChange={(e) => settings.set("instance", e.target.value)} />
        </label>
        <label className="field">
          <span>session</span>
          <input value={settings.session} onChange={(e) => settings.set("session", e.target.value)} />
        </label>
        <label className="field">
          <span>diff base (optional)</span>
          <input value={base} placeholder="origin/main" onChange={(e) => setBase(e.target.value)} />
        </label>
        <div style={{ alignSelf: "end" }}>
          <button className="btn" disabled={busy} onClick={() => void load()}>
            {busy ? "…" : "load workspaces"}
          </button>
        </div>
      </div>

      {loadError && <p className="card-error">{loadError}</p>}
      {loaded && !loadError && !busy && workspaces.length === 0 && (
        <div className="empty-hint">
          No workspaces in this session yet — spawn one from the console (POST …/agents with a cwd) and reload.
        </div>
      )}

      {workspaces.map((ws) => (
        <section className="ws-card" key={ws.workspace_id}>
          <header>
            <h3>{ws.workspace_id}</h3>
            {ws.label && <span className="chip auth">{ws.label}</span>}
            <span className="cwd">{ws.cwd ?? "cwd unknown"}</span>
          </header>
          {ws.agents.length > 0 && (
            <div className="agent-dots">
              {ws.agents.map((a) => (
                <span key={a.pane_id} className="a">
                  <span className={`s-${a.status}`}>●</span> {a.agent} <span className="note">{a.pane_id}</span>
                </span>
              ))}
            </div>
          )}
          {ws.repos.length === 0 && <div className="repo-row note">no git repos discovered in this workspace</div>}
          {ws.repos.map((r) => (
            <div className="repo-row" key={r.path}>
              <span className="name">{r.name}</span>
              <span className="branch">⎇ {r.branch}</span>
              {r.dirty && <span className="dirty">● DIRTY</span>}
              <span className="note">{r.path}</span>
              <span className="spacer" />
              <button className="btn ghost small" onClick={() => void browse(ws.workspace_id, r.path)}>
                browse
              </button>
            </div>
          ))}
        </section>
      ))}

      {selected && (
        <div className="browse-grid">
          <div className="tree-pane">
            <div className="pane-title">
              tree · {selected.repo === "." ? "workspace root" : selected.repo}
              <span className="spacer" />
              {tree?.truncated && <span className="dirty">truncated</span>}
            </div>
            <div className="tree-scroll">
              {tree ? <Tree node={tree.tree} depth={0} /> : <span className="note"> loading…</span>}
            </div>
          </div>
          <div className="diff-pane">
            <div className="pane-title">
              git diff {diff?.branch && <span className="branch">⎇ {diff.branch}</span>}
              <span className="spacer" />
              {diff?.truncated && <span className="dirty">truncated</span>}
              <button
                className="btn ghost small"
                onClick={() => void browse(selected.ws, selected.repo)}
              >
                re-diff{base.trim() ? ` vs ${base}` : ""}
              </button>
            </div>
            {paneError && <p className="card-error" style={{ padding: "0.6rem" }}>{paneError}</p>}
            {diff && (
              <DiffView
                text={
                  (diff.status.length > 0
                    ? `# status\n${diff.status.map((s) => `${s.state.padEnd(2)} ${s.path}`).join("\n")}\n`
                    : "# working tree clean\n") + (diff.diff ? `\n${diff.diff}` : "")
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Tree({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  if (node.type === "file") {
    return (
      <div className="tree-node">
        <div className="row file">
          <span className="glyph">·</span>
          {node.name}
        </div>
      </div>
    );
  }
  return (
    <div className="tree-node">
      <div className="row dir" onClick={() => setOpen(!open)}>
        <span className="glyph">{open ? "▾" : "▸"}</span>
        {node.name}/
      </div>
      {open && (
        <div className="tree-kids">
          {(node.children ?? []).map((c, i) => (
            <Tree key={`${c.name}-${i}`} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
