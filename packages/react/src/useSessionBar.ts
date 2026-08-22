import type { BrokerClient } from "@jefelabs/herdr-broker-client";
import { useCallback, useState } from "react";
import { useBrokerOr } from "./context.js";

/** Session-exit behavior: logOff() forgets the token locally (still valid
 * elsewhere — the host owns storage); kickOut() self-evicts at the broker
 * (DELETE /auth) and then forgets it, clearing locally even when the
 * revoke fails because the token is already dead upstream. Extracted from
 * the SessionBar organism, which now consumes it. */
export function useSessionBar(
  opts: { onLoggedOff: () => void },
  brokerArg?: BrokerClient,
): { busy: boolean; logOff: () => void; kickOut: () => Promise<void> } {
  const broker = useBrokerOr(brokerArg);
  const [busy, setBusy] = useState(false);
  const { onLoggedOff } = opts;

  const kickOut = useCallback(async () => {
    setBusy(true);
    try {
      await broker.signOut();
    } catch {
      // token already dead upstream — clearing locally is still right
    }
    onLoggedOff();
  }, [broker, onLoggedOff]);

  return { busy, logOff: onLoggedOff, kickOut };
}
