import { WorkspaceBrowser } from "@jefelabs/herdr-broker-ui";
import { useSettings } from "../settings";

/** Thin page: title + instance/session pickers around the reusable
 * WorkspaceBrowser organism from @jefelabs/herdr-broker-ui. */
export function WorkspacePage() {
  const settings = useSettings();
  return (
    <div className="page">
      <h1 style={{ fontFamily: "var(--display)", letterSpacing: "0.06em" }}>Workspace browser</h1>
      <p className="note" style={{ maxWidth: "46rem" }}>
        A working set is a directory plus the team running in it. This page is the ui package's
        WorkspaceBrowser organism riding the client SDK — the demo only supplies the broker and pickers.
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
      </div>
      <WorkspaceBrowser broker={settings.broker} instance={settings.instance} session={settings.session} />
    </div>
  );
}
