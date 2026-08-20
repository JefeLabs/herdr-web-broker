import { BrokerApiError } from "@jefelabs/herdr-broker-client";
import { useEffect, useRef, useState } from "react";
import { useSettings } from "../settings";

interface LogLine {
  dir: "in" | "out" | "sys";
  text: string;
  ts: string;
}

const now = () => new Date().toLocaleTimeString([], { hour12: false });

/** WS /parent/ws through the SDK's EventChannel: subprotocol bearer auth,
 * auto-reconnect, typed subscriptions, rpc frames on the same socket. */
export function EventsCard() {
  const settings = useSettings();
  const logRef = useRef<HTMLDivElement | null>(null);
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [frame, setFrame] = useState(
    JSON.stringify({ instance: "runtime", session: "default", method: "agent.list", params: {} }, null, 2),
  );

  const push = (dir: LogLine["dir"], text: string) => setLog((old) => [...old.slice(-400), { dir, text, ts: now() }]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => {
    const events = settings.broker.events;
    const offs = [
      events.on("open", () => {
        setConnected(true);
        push("sys", "open — subprotocol bearer auth; status events stream unsolicited");
      }),
      events.on("close", (e) => {
        setConnected(false);
        const clean = (e as { clean?: boolean })?.clean;
        push("sys", clean ? "closed" : "dropped — reconnecting with backoff");
      }),
      events.on("agent_status", (e) => push("in", `agent_status ${JSON.stringify(e)}`)),
      events.on("instance_online", (e) => push("in", `instance_online ${JSON.stringify(e)}`)),
      events.on("instance_offline", (e) => push("in", `instance_offline ${JSON.stringify(e)}`)),
    ];
    return () => offs.forEach((off) => off());
  }, [settings.broker]);

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
      const result = await settings.broker.events.rpc(
        parsed.instance ?? settings.instance,
        parsed.session ?? settings.session,
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
        <code className="mono-path">/parent/ws</code>
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
            <button className="btn" onClick={() => settings.broker.events.connect()}>
              connect
            </button>
          ) : (
            <button className="btn danger" onClick={() => settings.broker.events.close()}>
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
