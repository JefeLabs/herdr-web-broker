import type { AgentInfo } from "@jefelabs/herdr-broker-client";
import { PaneViewer } from "@jefelabs/herdr-broker-ui";
import { useCallback, useEffect, useState } from "react";
import { useSettings } from "../settings";

/** Thin page: pane picker around the ui package's PaneViewer organism.
 * Pick an agent's pane and watch its terminal live — the long-poll screen
 * endpoint delivers a frame only when the screen actually changes. */
export function PanePage() {
  const settings = useSettings();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [pane, setPane] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const list = await settings.broker.instance(settings.instance).session(settings.session).agents({ fresh: true });
      setAgents(list);
      setPane((cur) => (cur && list.some((a) => a.id === cur) ? cur : (list[0]?.id ?? "")));
    } catch (e) {
      setAgents([]);
      setErr(String(e));
    }
  }, [settings.broker, settings.instance, settings.session]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <h1 style={{ fontFamily: "var(--display)", letterSpacing: "0.06em" }}>Pane viewer</h1>
      <p className="note" style={{ maxWidth: "46rem" }}>
        The agent's actual terminal, live in the browser. GET …/panes/{"{pane}"}/screen long-polls by content
        version — a frame arrives only when the screen changes — and the input bar writes back through
        pane.send_input, so trust dialogs and quick answers happen right here.
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
          <span>pane</span>
          <select value={pane} onChange={(e) => setPane(e.target.value)}>
            {agents.length === 0 && <option value="">— no agents —</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id} · {a.title} · {a.status}
              </option>
            ))}
          </select>
        </label>
        <button className="btn ghost" onClick={() => void load()}>
          refresh agents
        </button>
      </div>
      {err && <p className="note term-error">{err}</p>}
      {pane ? (
        <PaneViewer
          key={`${settings.instance}/${settings.session}/${pane}`}
          broker={settings.broker}
          instance={settings.instance}
          session={settings.session}
          paneId={pane}
        />
      ) : (
        <p className="note">Spawn an agent from the Console, then pick its pane here.</p>
      )}
    </div>
  );
}
