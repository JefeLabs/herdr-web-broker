import type { BrokerClient, EventChannel } from "@jefelabs/herdr-broker-client";
import { useCallback, useEffect, useState } from "react";
import { useBrokerOr } from "./context.js";

/** Connection state for the broker's WS event stream, plus connect/close
 * controls and the raw channel for typed subscriptions. Extracted from
 * the EventsPanel organism, which now consumes it. */
export function useEventChannel(brokerArg?: BrokerClient): {
  connected: boolean;
  connect: () => void;
  close: () => void;
  channel: EventChannel;
} {
  const broker = useBrokerOr(brokerArg);
  const channel = broker.events;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const offs = [
      channel.on("open", () => setConnected(true)),
      channel.on("close", () => setConnected(false)),
      channel.on("auth_failed", () => setConnected(false)),
    ];
    return () => offs.forEach((off) => off());
  }, [channel]);

  const connect = useCallback(() => channel.connect(), [channel]);
  const close = useCallback(() => channel.close(), [channel]);

  return { connected, connect, close, channel };
}
