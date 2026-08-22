import { BrokerNetworkError, type BrokerClient } from "@jefelabs/herdr-broker-client";
import { useCallback, useEffect, useState } from "react";
import { useBrokerOr } from "./context.js";

export type VerifyState = "checking" | "ok" | "denied";

/** The auth-gate state machine as a hook: a stored token is verified live
 * on mount (possession is not authentication), verify() re-checks a new
 * candidate, and an emptied token re-locks immediately. Extracted from
 * the AuthGate organism, which now consumes it. */
export function useVerify(token: string, brokerArg?: BrokerClient) {
  const broker = useBrokerOr(brokerArg);
  const [state, setState] = useState<VerifyState>("checking");
  const [error, setError] = useState<string | null>(null);

  const verify = useCallback(
    async (candidate: string): Promise<boolean> => {
      setState("checking");
      setError(null);
      broker.setToken(candidate);
      try {
        const res = await broker.verify();
        if (res.ok) {
          setState("ok");
          return true;
        }
        setState("denied");
        setError(res.error?.message ?? "token rejected");
        return false;
      } catch (e) {
        setState("denied");
        setError(e instanceof BrokerNetworkError ? "broker unreachable — is it running?" : String(e));
        return false;
      }
    },
    [broker],
  );

  useEffect(() => {
    void verify(token);
    // mount-time verify of the stored token only — edits re-verify via verify()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No token means not authenticated: re-lock the moment the host clears it.
  useEffect(() => {
    if (token === "") setState((s) => (s === "ok" ? "denied" : s));
  }, [token]);

  return { state, error, verify };
}
