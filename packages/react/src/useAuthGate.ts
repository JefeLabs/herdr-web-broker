import type { BrokerClient } from "@jefelabs/herdr-broker-client";
import { useCallback, useState } from "react";
import { useVerify, type VerifyState } from "./useVerify.js";

export interface AuthGateOpts {
  /** current token value (controlled by the host app) */
  token: string;
  onTokenChange: (token: string) => void;
  /** optional presence identify, sent best-effort after a successful verify */
  onIdentify?: (id: { name?: string; email?: string }) => Promise<unknown>;
  /** dev-only self-serve mint: obtain a token however the host chooses */
  onRequestToken?: () => Promise<string>;
}

/** The auth-gate behavior with no markup: verify-on-mount via useVerify,
 * attempt() for candidate tokens (+ best-effort identify), requestToken()
 * for the one-click mint flow. Skins render the form; this decides.
 * Extracted from the AuthGate organism, which now consumes it. */
export function useAuthGate(opts: AuthGateOpts, brokerArg?: BrokerClient): {
  state: VerifyState;
  error: string | null;
  attempt: (candidate: string, identity?: { name?: string; email?: string }) => Promise<boolean>;
  requestToken: (identity?: { name?: string; email?: string }) => Promise<void>;
} {
  const { state, error: verifyError, verify } = useVerify(opts.token, brokerArg);
  const [localError, setLocalError] = useState<string | null>(null);
  const { onIdentify, onTokenChange, onRequestToken } = opts;

  const attempt = useCallback(
    async (candidate: string, identity?: { name?: string; email?: string }) => {
      setLocalError(null);
      const ok = await verify(candidate);
      if (ok && onIdentify && identity && (identity.name || identity.email)) {
        await onIdentify(identity).catch(() => undefined); // presence is best-effort
      }
      return ok;
    },
    [verify, onIdentify],
  );

  const requestToken = useCallback(
    async (identity?: { name?: string; email?: string }) => {
      if (!onRequestToken) return;
      setLocalError(null);
      try {
        const minted = await onRequestToken();
        onTokenChange(minted);
        await attempt(minted, identity);
      } catch (e) {
        setLocalError(e instanceof Error ? e.message : String(e));
      }
    },
    [onRequestToken, onTokenChange, attempt],
  );

  return { state, error: localError ?? verifyError, attempt, requestToken };
}
