import type { BrokerClient, Screen, ScreenSource } from "@jefelabs/herdr-broker-client";
import { useEffect, useMemo, useRef, useState } from "react";

export interface PaneViewerProps {
  broker: BrokerClient;
  instance: string;
  session: string;
  paneId: string;
}

/** Live terminal view of an agent's pane: the SDK's watchScreen long-poll
 * loop delivers changed frames only, so an idle pane costs one waiting
 * request, not a render storm. The input bar is the write half — text goes
 * through pane.send_input (Enter included), Esc through pane.send_keys —
 * so first-run dialogs can be answered from the same panel. */
export function PaneViewer({ broker, instance, session, paneId }: PaneViewerProps) {
  const agent = useMemo(
    () => broker.instance(instance).session(session).agent(paneId),
    [broker, instance, session, paneId],
  );
  const [source, setSource] = useState<ScreenSource>("visible");
  const [live, setLive] = useState(true);
  const [frame, setFrame] = useState<Screen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const screenRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!live) return;
    setError(null);
    return agent.watchScreen((s) => setFrame(s), {
      source,
      onError: (e) => setError(String(e)),
    });
  }, [agent, source, live]);

  useEffect(() => {
    const el = screenRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [frame]);

  async function send() {
    const text = input;
    if (!text.trim()) return;
    setInput("");
    try {
      await agent.type(text);
    } catch (e) {
      setError(String(e));
    }
  }

  async function esc() {
    try {
      await agent.keys(["Escape"]);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <article className="card pane-viewer">
      <div className="card-head">
        <span className="chip get">PANE</span>
        <code className="mono-path">{paneId}</code>
        <span className="spacer" />
        {(["visible", "recent"] as const).map((s) => (
          <button key={s} className={`btn ghost ${source === s ? "active" : ""}`} onClick={() => setSource(s)}>
            {s}
          </button>
        ))}
        <button className="btn ghost" onClick={() => setLive((v) => !v)}>
          {live ? "pause" : "resume"}
        </button>
        <span className={`status-pill ${live ? "ok" : ""}`}>{live ? "▮ live" : "▯ paused"}</span>
      </div>
      <div className="card-body">
        <pre className="term-screen" ref={screenRef} data-source={source}>
          {frame ? frame.text : "— waiting for the first frame —"}
        </pre>
        <div className="term-status">
          {frame && (
            <>
              <span>v {frame.version}</span>
              <span>as of {frame.as_of}</span>
              {frame.truncated && <span className="chip auth">tail-truncated</span>}
            </>
          )}
          {error && <span className="term-error">{error}</span>}
        </div>
        <div className="term-bar">
          <input
            value={input}
            placeholder="type into the pane — Enter is sent for you"
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void send();
            }}
          />
          <button className="btn" onClick={() => void send()}>
            send
          </button>
          <button className="btn danger" onClick={() => void esc()} title="pane.send_keys [Escape] — the portable interrupt">
            Esc
          </button>
        </div>
      </div>
    </article>
  );
}
