import { BrokerApiError, type BrokerClient } from "@jefelabs/herdr-broker-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBrokerOr } from "./context.js";
import { useEventChannel } from "./useEventChannel.js";

export interface LogLine {
  dir: "in" | "out" | "sys";
  text: string;
  ts: string;
}

const now = () => new Date().toLocaleTimeString([], { hour12: false });

/** The events panel's whole behavior: WS connection state, a capped log of
 * traffic (typed status listeners included), rpc frames sent from raw
 * JSON, and herdr event-passthrough subscription groups (parse a
 * comma-separated type list, stream ⚡ lines, honest sub_closed). Skins
 * render the log and controls; this produces every line. Extracted from
 * the EventsPanel organism, which now consumes it. */
export function useEventsPanel(
  opts: { instance: string; session: string },
  brokerArg?: BrokerClient,
): {
  connected: boolean;
  connect: () => void;
  close: () => void;
  log: LogLine[];
  sendFrame: (frameJson: string) => Promise<void>;
  subscribed: boolean;
  subscribe: (typesCsv: string) => Promise<void>;
  unsubscribe: () => void;
} {
  const broker = useBrokerOr(brokerArg);
  const { connected, connect, close } = useEventChannel(broker);
  const [log, setLog] = useState<LogLine[]>([]);
  const [subscribed, setSubscribed] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const { instance, session } = opts;

  const push = useCallback(
    (dir: LogLine["dir"], text: string) => setLog((old) => [...old.slice(-400), { dir, text, ts: now() }]),
    [],
  );

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
  }, [broker, push]);

  // the group survives socket reconnects (the SDK re-subscribes itself);
  // unmount and unsubscribe() retire it
  useEffect(() => () => unsubRef.current?.(), []);

  const sendFrame = useCallback(
    async (frameJson: string) => {
      let parsed: { instance?: string; session?: string; method?: string; params?: unknown };
      try {
        parsed = JSON.parse(frameJson) as typeof parsed;
      } catch {
        push("sys", "frame is not valid JSON");
        return;
      }
      push("out", frameJson.replace(/\s*\n\s*/g, " "));
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
    },
    [broker, instance, session, push],
  );

  const subscribe = useCallback(
    async (typesCsv: string) => {
      const subscriptions = typesCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((type) => ({ type }));
      if (subscriptions.length === 0) {
        push("sys", "give at least one subscription type, e.g. pane.created");
        return;
      }
      try {
        const unsub = await broker.events.subscribe(
          { instance, session, subscriptions },
          (name, data) => push("in", `⚡ ${name} ${JSON.stringify(data).slice(0, 400)}`),
          (reason) => {
            unsubRef.current = null;
            setSubscribed(false);
            push("sys", `subscription closed: ${reason}`);
          },
        );
        unsubRef.current = unsub;
        setSubscribed(true);
        push("sys", `subscribed to ${subscriptions.map((s) => s.type).join(", ")} on ${instance}/${session}`);
      } catch (e) {
        push("sys", e instanceof BrokerApiError ? `${e.code}: ${e.message}` : String(e));
      }
    },
    [broker, instance, session, push],
  );

  const unsubscribe = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    setSubscribed(false);
    push("sys", "unsubscribed");
  }, [push]);

  return { connected, connect, close, log, sendFrame, subscribed, subscribe, unsubscribe };
}
