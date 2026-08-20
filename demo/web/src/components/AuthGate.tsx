import { BrokerNetworkError } from "@jefelabs/herdr-broker-client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSettings } from "../settings";

/** Live auth gate: the wrapped page renders only after the bearer token has
 * been verified against the broker (broker.verify() → GET /parent). A
 * stored token is re-verified on mount — possession of localStorage is not
 * authentication. */
export function AuthGate({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const [state, setState] = useState<"checking" | "ok" | "denied">("checking");
  const [error, setError] = useState<string | null>(null);

  const verify = useCallback(
    async (token: string) => {
      setState("checking");
      setError(null);
      settings.broker.setToken(token);
      try {
        const res = await settings.broker.verify();
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
    [settings.broker],
  );

  useEffect(() => {
    void verify(settings.bearer);
    // verify only on mount — edits re-verify through the button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "ok") return <>{children}</>;

  return (
    <div className="page">
      <div className="auth-gate">
        <h2>Authentication required</h2>
        <p className="note">
          Workspaces expose team activity and repository contents, so this page only renders after the broker
          accepts your bearer token (a live GET /parent — not just a stored value).
        </p>
        <label className="field">
          <span>bearer token</span>
          <input
            type="password"
            value={settings.bearer}
            placeholder="from [[client_tokens]] in config.toml"
            onChange={(e) => settings.set("bearer", e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void verify(settings.bearer)}
          />
        </label>
        <div className="card-actions">
          <button className="btn" disabled={state === "checking"} onClick={() => void verify(settings.bearer)}>
            {state === "checking" ? "verifying…" : "authenticate"}
          </button>
          {error && <span className="card-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
