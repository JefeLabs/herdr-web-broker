import type { BrokerClient } from "@jefelabs/herdr-broker-client";
import { useEventsPanel } from "@jefelabs/herdr-broker-react";
import { useEffect, useRef, useState } from "react";

export interface EventsPanelProps {
  broker: BrokerClient;
  instance: string;
  session: string;
}

/** WS /events through the SDK's EventChannel: subprotocol bearer auth,
 * auto-reconnect, rpc frames, and herdr event-passthrough subscriptions.
 * All behavior (log lines included) lives in useEventsPanel; this is the
 * default skin — it holds only form state and markup. */
export function EventsPanel({ broker, instance, session }: EventsPanelProps) {
  const logRef = useRef<HTMLDivElement | null>(null);
  const { connected, connect, close, log, sendFrame, subscribed, subscribe, unsubscribe } = useEventsPanel(
    { instance, session },
    broker,
  );
  const [frame, setFrame] = useState(
    JSON.stringify({ instance, session, method: "agent.list", params: {} }, null, 2),
  );
  const [subTypes, setSubTypes] = useState("workspace.created, pane.created, pane.agent_status_changed");

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <article className="card" id="ws">
      <div className="card-head">
        <span className="chip ws">WS</span>
        <code className="mono-path">/events</code>
        <span className="spacer" />
        <span className="chip auth">bearer</span>
      </div>
      <div className="card-body">
        <p className="card-summary">
          Driven by the SDK's EventChannel: auth rides the {'["bearer", token]'} subprotocols (a header browsers
          can set — the token never touches the URL), unclean drops reconnect with backoff, and rpc frames share
          the socket with unsolicited agent-status events.
        </p>
        <div className="card-actions">
          {!connected ? (
            <button className="btn" onClick={connect}>
              connect
            </button>
          ) : (
            <button className="btn danger" onClick={close}>
              disconnect
            </button>
          )}
          <span className={`status-pill ${connected ? "ok" : ""}`}>{connected ? "▮ live" : "▯ closed"}</span>
        </div>
        <label className="field">
          <span>rpc frame (id is managed by the SDK)</span>
          <textarea rows={5} value={frame} onChange={(e) => setFrame(e.target.value)} spellCheck={false} />
        </label>
        <div className="card-actions">
          <button className="btn ghost" disabled={!connected} onClick={() => void sendFrame(frame)}>
            send frame
          </button>
        </div>
        <label className="field">
          <span>herdr subscriptions (comma-separated types — pushed as ⚡ lines below)</span>
          <input
            value={subTypes}
            onChange={(e) => setSubTypes(e.target.value)}
            spellCheck={false}
            disabled={subscribed}
          />
        </label>
        <div className="card-actions">
          {!subscribed ? (
            <button className="btn ghost" disabled={!connected} onClick={() => void subscribe(subTypes)}>
              subscribe
            </button>
          ) : (
            <button className="btn danger" onClick={unsubscribe}>
              unsubscribe
            </button>
          )}
          <span className={`status-pill ${subscribed ? "ok" : ""}`}>
            {subscribed ? "⚡ streaming herdr events" : "no herdr subscription"}
          </span>
        </div>
        <div className="evt-log" ref={logRef}>
          {log.length === 0 && <span className="sys">— no traffic yet —</span>}
          {log.map((l, i) => (
            <div key={i} className={l.dir}>
              <span className="ts">{l.ts}</span>
              {l.dir === "out" ? "→ " : l.dir === "in" ? "← " : "· "}
              {l.text}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}
