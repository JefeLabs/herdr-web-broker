import { BrokerNetworkError, type BrokerClient } from "@jefelabs/herdr-broker-client";
import { useCallback, useEffect, useState, type ReactNode } from "react";

export interface AuthGateProps {
  broker: BrokerClient;
  /** current token value (controlled by the host app) */
  token: string;
  onTokenChange: (token: string) => void;
  children: ReactNode;
}

/** Live auth gate: children render only after the bearer token has been
 * verified against the broker (broker.verify()). A stored token is
 * re-verified on mount — possession of storage is not authentication. */
export function AuthGate({ broker, token, onTokenChange, children }: AuthGateProps) {
  const [state, setState] = useState<"checking" | "ok" | "denied">("checking");
  const [error, setError] = useState<string | null>(null);

  const verify = useCallback(
    async (candidate: string) => {
      setState("checking");
      setError(null);
      broker.setToken(candidate);
      try {
        const res = await broker.verify();
        if (res.ok) {
          setState("ok");
        } else {
          setState("denied");
          setError(res.error?.message ?? "token rejected");
        }
      } catch (e) {
        setState("denied");
        setError(e instanceof BrokerNetworkError ? "broker unreachable — is it running?" : String(e));
      }
    },
    [broker],
  );

  useEffect(() => {
    void verify(token);
    // verify only on mount — edits re-verify through the button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "ok") return <>{children}</>;

  return (
    <div className="page">
      <div className="auth-gate">
        <h2>Authentication required</h2>
        <p className="note">
          This area exposes team activity and repository contents, so it only renders after the broker accepts
          your bearer token (a live check — not just a stored value).
        </p>
        <label className="field">
          <span>bearer token</span>
          <input
            type="password"
            value={token}
            placeholder="from [[client_tokens]] in config.toml"
            onChange={(e) => onTokenChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void verify(token)}
          />
        </label>
        <div className="card-actions">
          <button className="btn" disabled={state === "checking"} onClick={() => void verify(token)}>
            {state === "checking" ? "verifying…" : "authenticate"}
          </button>
          {error && <span className="card-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
