import type { BrokerClient, ScreenSource } from "@jefelabs/herdr-broker-client";
import { usePaneViewer } from "@jefelabs/herdr-broker-react";
import { useEffect, useRef } from "react";

export interface PaneViewerProps {
  broker: BrokerClient;
  instance: string;
  session: string;
  paneId: string;
}

/** Live terminal view of an agent's pane: changed frames only via the
 * SDK's watchScreen long-poll, plus the write half (send_input text, Esc
 * interrupt) so first-run dialogs can be answered from the same panel.
 * All behavior lives in usePaneViewer; this is the default skin. */
export function PaneViewer({ broker, instance, session, paneId }: PaneViewerProps) {
  const { frame, source, setSource, live, setLive, input, setInput, send, interrupt, error } = usePaneViewer(
    { instance, session, paneId },
    broker,
  );
  const screenRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const el = screenRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [frame]);

  return (
    <article className="card pane-viewer">
      <div className="card-head">
        <span className="chip get">PANE</span>
        <code className="mono-path">{paneId}</code>
        <span className="spacer" />
        {(["visible", "recent"] as ScreenSource[]).map((s) => (
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
          <button className="btn danger" onClick={() => void interrupt()} title="pane.send_keys [Escape] — the portable interrupt">
            Esc
          </button>
        </div>
      </div>
    </article>
  );
}
