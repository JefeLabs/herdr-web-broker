import { BrokerApiError, type BrokerClient } from "@jefelabs/herdr-broker-client";
import { useEffect, useRef, useState } from "react";
import { useEventChannel } from "../hooks/useEventChannel.js";

export interface EventsPanelProps {
  broker: BrokerClient;
  instance: string;
  session: string;
}

interface LogLine {
  dir: "in" | "out" | "sys";
  text: string;
  ts: string;
}

const now = () => new Date().toLocaleTimeString([], { hour12: false });

/** WS /events through the SDK's EventChannel: subprotocol bearer auth,
 * auto-reconnect, typed subscriptions, rpc frames on the same socket. */
export function EventsPanel({ broker, instance, session }: EventsPanelProps) {
  const logRef = useRef<HTMLDivElement | null>(null);
  // connection state + controls live in the hook; the log stays local
  const { connected, connect, close } = useEventChannel(broker);
  const [log, setLog] = useState<LogLine[]>([]);
  const [frame, setFrame] = useState(
    JSON.stringify({ instance, session, method: "agent.list", params: {} }, null, 2),
  );

  const push = (dir: LogLine["dir"], text: string) => setLog((old) => [...old.slice(-400), { dir, text, ts: now() }]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => {
    const events = broker.events;
    const offs = [
      events.on("open", () => push("sys", "open — subprotocol bearer auth; status events stream unsolicited")),
      events.on("close", (e) => {
        const clean = (e as { clean?: boolean })?.clean;
        push("sys", clean ? "closed" : "dropped — reconnecting with backoff");
      }),
      events.on("auth_failed", () =>
        push("sys", "token rejected (revoked or kicked) — reconnect stopped; re-authenticate to resume"),
      ),
      events.on("agent_status", (e) => push("in", `agent_status ${JSON.stringify(e)}`)),
      events.on("instance_online", (e) => push("in", `instance_online ${JSON.stringify(e)}`)),
      events.on("instance_offline", (e) => push("in", `instance_offline ${JSON.stringify(e)}`)),
    ];
    return () => offs.forEach((off) => off());
  }, [broker]);

  async function sendFrame() {
    let parsed: { instance?: string; session?: string; method?: string; params?: unknown };
    try {
      parsed = JSON.parse(frame) as typeof parsed;
    } catch {
      push("sys", "frame is not valid JSON");
      return;
    }
    push("out", frame.replace(/\s*\n\s*/g, " "));
    try {
      const result = await broker.events.rpc(
        parsed.instance ?? instance,
        parsed.session ?? session,
        parsed.method ?? "ping",
        parsed.params ?? {},
      );
      push("in", JSON.stringify(result).slice(0, 400));
    } catch (e) {
      push("sys", e instanceof BrokerApiError ? `${e.code}: ${e.message}` : String(e));
    }
  }

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
          <button className="btn ghost" disabled={!connected} onClick={() => void sendFrame()}>
            send frame
          </button>
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
