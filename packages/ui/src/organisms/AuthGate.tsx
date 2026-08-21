import { BrokerNetworkError, type BrokerClient } from "@jefelabs/herdr-broker-client";
import { useCallback, useEffect, useState, type ReactNode } from "react";

export interface AuthGateProps {
  broker: BrokerClient;
  /** current token value (controlled by the host app) */
  token: string;
  onTokenChange: (token: string) => void;
  /** when provided, optional name/email fields are shown and sent here
   * after a successful verify — "let others see who's using this instance" */
  onIdentify?: (id: { name?: string; email?: string }) => Promise<unknown>;
  /** dev-only self-serve: when provided, a "get a demo token" button mints
   * a token (however the host obtains one), fills it, and verifies — the
   * one-click way into a demo instance */
  onRequestToken?: () => Promise<string>;
  children: ReactNode;
}

/** Live auth gate: children render only after the bearer token has been
 * verified against the broker (broker.verify()). A stored token is
 * re-verified on mount — possession of storage is not authentication. */
export function AuthGate({ broker, token, onTokenChange, onIdentify, onRequestToken, children }: AuthGateProps) {
  const [state, setState] = useState<"checking" | "ok" | "denied">("checking");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const verify = useCallback(
    async (candidate: string, identity?: { name?: string; email?: string }) => {
      setState("checking");
      setError(null);
      broker.setToken(candidate);
      try {
        const res = await broker.verify();
        if (res.ok) {
          if (onIdentify && identity && (identity.name || identity.email)) {
            await onIdentify(identity).catch(() => undefined); // presence is best-effort
          }
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
    [broker, onIdentify],
  );

  useEffect(() => {
    void verify(token);
    // verify only on mount — edits re-verify through the button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No token means not authenticated: when the host clears it (log off,
  // kick out), the gate re-locks immediately instead of waiting for a
  // reload to notice.
  useEffect(() => {
    if (token === "") setState((s) => (s === "ok" ? "denied" : s));
  }, [token]);

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
            onKeyDown={(e) => e.key === "Enter" && void verify(token, { name, email })}
          />
        </label>
        {onIdentify && (
          <>
            <p className="note">Optional — let others see who is using this instance:</p>
            <label className="field">
              <span>your name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Kathia" />
            </label>
            <label className="field">
              <span>your email</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
          </>
        )}
        <div className="card-actions">
          <button
            className="btn"
            disabled={state === "checking"}
            onClick={() => void verify(token, { name, email })}
          >
            {state === "checking" ? "verifying…" : "authenticate"}
          </button>
          {onRequestToken && (
            <button
              className="btn ghost"
              disabled={state === "checking"}
              onClick={() =>
                void (async () => {
                  setError(null);
                  try {
                    const minted = await onRequestToken();
                    onTokenChange(minted);
                    await verify(minted, { name, email });
                  } catch (e) {
                    setState("denied");
                    setError(e instanceof Error ? e.message : String(e));
                  }
                })()
              }
            >
              get a demo token
            </button>
          )}
          {error && <span className="card-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
