import type { BrokerClient, TreeNode } from "@jefelabs/herdr-broker-client";
import { useRepoBrowser } from "@jefelabs/herdr-broker-react";
import { useState } from "react";
import { DiffView } from "../molecules/DiffView.js";

export interface WorkspaceBrowserProps {
  broker: BrokerClient;
  instance: string;
  session: string;
}

/** Workspace browsing organism: one working set, n repos — roster, file
 * trees from git's index, diffs against any base. All fetching lives in
 * useRepoBrowser; this is the default skin. */
export function WorkspaceBrowser({ broker, instance, session }: WorkspaceBrowserProps) {
  const { workspaces, loaded, busy, loadError, load, selected, tree, diff, base, setBase, browseError, browse } =
    useRepoBrowser({ instance, session }, broker);

  return (
    <>
      <div className="ws-pickers">
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
          No workspaces in this session yet — spawn one (POST …/agents with a cwd) and reload.
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
          {ws.repos.length === 0 && (
            <div className="repo-row note">
              no repo yet — ask your agent to git init; diff, commit, and push activate on the next load
            </div>
          )}
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
              <button className="btn ghost small" onClick={() => void browse(selected.ws, selected.repo)}>
                re-diff{base.trim() ? ` vs ${base}` : ""}
              </button>
            </div>
            {browseError && (
              <p className="card-error" style={{ padding: "0.6rem" }}>
                {browseError}
              </p>
            )}
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
    </>
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
