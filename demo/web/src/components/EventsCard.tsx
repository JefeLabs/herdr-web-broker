import { useEffect, useRef, useState } from "react";
import { wsUrl } from "../api/client";
import { useSettings } from "../settings";
import { CopyButton } from "./ui";

interface LogLine {
  dir: "in" | "out" | "sys";
  text: string;
  ts: string;
}

const now = () => new Date().toLocaleTimeString([], { hour12: false });

/** WS /parent/ws — unsolicited agent_status / instance.online / offline
 * pushes plus duplex rpc frames on the same connection. */
export function EventsCard() {
  const settings = useSettings();
  const ws = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [frame, setFrame] = useState(
    JSON.stringify({ id: "1", instance: "runtime", session: "default", method: "agent.list", params: {} }, null, 2),
  );

  const push = (dir: LogLine["dir"], text: string) =>
    setLog((old) => [...old.slice(-400), { dir, text, ts: now() }]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => () => ws.current?.close(), []);

  function connect() {
    const url = wsUrl(settings.bearer, window.location);
    const sock = new WebSocket(url);
    ws.current = sock;
    push("sys", `connecting ${url}`);
    sock.onopen = () => {
      setConnected(true);
      push("sys", "open — status events stream unsolicited; rpc frames go out on the same socket");
    };
    sock.onmessage = (e) => push("in", String(e.data));
    sock.onclose = (e) => {
      setConnected(false);
      push("sys", `closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`);
    };
    sock.onerror = () => push("sys", "socket error (bad token?)");
  }

  function disconnect() {
    ws.current?.close();
  }

  function sendFrame() {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) return;
    ws.current.send(frame);
    push("out", frame.replace(/\s*\n\s*/g, " "));
  }

  const wire = wsUrl(settings.bearer || "$TOKEN", window.location);

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
          One duplex socket: rpc frames {"{id, instance, session, method, params}"} get {"{id, result|error}"}{" "}
          replies, while agent-status and instance online/offline events arrive unsolicited. The dev proxy lifts
          ?token= into the Authorization header the browser cannot set itself.
        </p>
        <div className="card-actions">
          {!connected ? (
            <button className="btn" onClick={connect}>
              connect
            </button>
          ) : (
            <button className="btn danger" onClick={disconnect}>
              disconnect
            </button>
          )}
          <span className={`status-pill ${connected ? "ok" : ""}`}>{connected ? "▮ live" : "▯ closed"}</span>
        </div>
        <div className="curl-line">
          <code>{wire}</code>
          <CopyButton text={wire} />
        </div>
        <label className="field">
          <span>rpc frame</span>
          <textarea rows={5} value={frame} onChange={(e) => setFrame(e.target.value)} spellCheck={false} />
        </label>
        <div className="card-actions">
          <button className="btn ghost" disabled={!connected} onClick={sendFrame}>
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
