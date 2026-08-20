import { BrokerApiError } from "@jefelabs/herdr-broker-client";
import { useState } from "react";
import { useSettings } from "../settings";

/** The one console card the text-field catalog can't express: a real file
 * picker. Uploads ride the SDK's context scope (raw PUT, 8MB cap). */
export function ContextUploadCard() {
  const settings = useSettings();
  const [workspaceId, setWorkspaceId] = useState("w1");
  const [active, setActive] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    if (!file) {
      setError("pick a file first");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const entry = await settings.broker
        .instance(settings.instance)
        .session(settings.session)
        .context(workspaceId)
        .upload(file.name, bytes, { contentType: file.type || "application/octet-stream", active });
      setResult(`uploaded ${entry.name} (${entry.content_type}, ${entry.size}B) — active: ${entry.active}`);
    } catch (e) {
      setError(e instanceof BrokerApiError ? `${e.code}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card" id="context-upload">
      <div className="card-head">
        <span className="chip post">PUT</span>
        <code className="mono-path">
          …/workspaces/<span className="var">{"{workspace_id}"}</span>/context/<span className="var">{"{name}"}</span>
        </code>
        <span className="spacer" />
        <span className="chip auth">bearer</span>
      </div>
      <div className="card-body">
        <p className="card-summary">
          Upload a context attachment — raw binary body, name from the file. Active attachments are listed in
          every prompt/ask/spec sent to agents in the workspace.
        </p>
        <div className="field-grid">
          <label className="field">
            <span>workspace_id</span>
            <input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} />
          </label>
          <label className="field">
            <span>file</span>
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            active — rides prompts
          </label>
        </div>
        <div className="card-actions">
          <button className="btn" disabled={busy} onClick={() => void upload()}>
            {busy ? "…" : "upload"}
          </button>
          {result && <span className="status-pill ok">▮ {result}</span>}
          {error && <span className="card-error">{error}</span>}
        </div>
      </div>
    </article>
  );
}
