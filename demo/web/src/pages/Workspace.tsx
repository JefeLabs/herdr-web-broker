import { useState } from "react";
import { send, type BrokerResult } from "../api/client";
import { CATALOG, type Ctx } from "../api/catalog";
import { DiffView, JsonView } from "../components/ui";
import { useSettings } from "../settings";

interface RepoInfo {
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
}
interface AgentInfo {
  agent: string;
  pane_id: string;
  status: "working" | "blocked" | "idle";
}
interface Workspace {
  workspace_id: string;
  cwd: string | null;
  label?: string;
  agents: AgentInfo[];
  repos: RepoInfo[];
}
interface TreeNode {
  name: string;
  type: "dir" | "file";
  children?: TreeNode[];
}
interface DiffResult {
  branch: string;
  status: { path: string; state: string }[];
  diff: string;
  truncated: boolean;
}

const specOf = (id: string) => {
  const s = CATALOG.find((e) => e.id === id);
  if (!s) throw new Error(`missing catalog entry ${id}`);
  return s;
};

/** Dedicated demo: one workspace, n repos — roster, file trees straight from
 * git's index, diffs against any base. Everything on this page is served by
 * the three Workspaces & Repos endpoints. */
export function WorkspaceBrowser() {
  const settings = useSettings();
  const ctx: Ctx = { instance: settings.instance, session: settings.session };
  const tokens = { bearer: settings.bearer, admin: settings.admin };

  const [res, setRes] = useState<BrokerResult | null>(null);
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
    try {
      setRes(await send(specOf("workspaces").build({}, ctx), tokens));
    } finally {
      setBusy(false);
    }
  }

  async function browse(ws: string, repo: string, baseRef = base) {
    setSelected({ ws, repo });
    setTree(null);
    setDiff(null);
    setPaneError(null);
    const [t, d] = await Promise.all([
      send(specOf("tree").build({ workspace_id: ws, repo }, ctx), tokens),
      send(
        specOf("diff").build({ workspace_id: ws, repo, ...(baseRef.trim() ? { base: baseRef } : {}) }, ctx),
        tokens,
      ),
    ]);
    if (t.ok) setTree(t.body as { tree: TreeNode; truncated: boolean });
    else setPaneError(JSON.stringify(t.body));
    if (d.ok) setDiff(d.body as DiffResult);
    else if (!paneError) setPaneError(JSON.stringify(d.body));
  }

  const workspaces = ((res?.body as { workspaces?: Workspace[] })?.workspaces ?? []).filter(Boolean);

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

      {res && !res.ok && <JsonView value={res.body} />}
      {res?.ok && workspaces.length === 0 && (
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
