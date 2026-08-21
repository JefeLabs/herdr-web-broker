import type { BrokerClient } from "@jefelabs/herdr-broker-client";
import { createContext, useContext, type ReactNode } from "react";

const BrokerContext = createContext<BrokerClient | null>(null);

/** App-level provider so hooks and components stop prop-drilling the
 * client. Every hook also accepts an explicit broker argument, which wins
 * over the context — organisms keep their `broker` prop unchanged. */
export function BrokerProvider({ broker, children }: { broker: BrokerClient; children: ReactNode }) {
  return <BrokerContext.Provider value={broker}>{children}</BrokerContext.Provider>;
}

export function useBroker(): BrokerClient {
  const broker = useContext(BrokerContext);
  if (!broker) {
    throw new Error("useBroker needs a <BrokerProvider> ancestor (or pass a broker explicitly to the hook)");
  }
  return broker;
}

/** Internal: explicit argument beats context; context fills the gap. */
export function useBrokerOr(explicit?: BrokerClient): BrokerClient {
  const fromContext = useContext(BrokerContext);
  const broker = explicit ?? fromContext;
  if (!broker) {
    throw new Error("this hook needs a <BrokerProvider> ancestor or an explicit broker argument");
  }
  return broker;
}
