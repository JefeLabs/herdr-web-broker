import type { BrokerClient } from "@jefelabs/herdr-broker-client";
import { useSessionBar } from "@jefelabs/herdr-broker-react";
import { CopyButton } from "../atoms/CopyButton.js";

export interface SessionBarProps {
  broker: BrokerClient;
  token: string;
  /** display identity; falls back to a generic "session" label */
  who?: string;
  /** clear the locally-stored token — the host owns storage */
  onLoggedOff: () => void;
  /** session ownership: logout-with-teardown — closes the caller's herdr
   * and every agent in it (DELETE .../sessions/{s}); rendered as a
   * clearly-destructive action only when the host provides it */
  onTeardown?: () => void | Promise<void>;
}

/** Post-login session controls: the bearer rides every request, so the bar
 * surfaces it (masked, copy for curl/Postman/SDK use) with two exits —
 * "log off" forgets it locally (still valid elsewhere), "kick out"
 * self-evicts at the broker and then forgets it. Behavior lives in
 * useSessionBar; this is the default skin. */
export function SessionBar({ broker, token, who, onLoggedOff, onTeardown }: SessionBarProps) {
  const { busy, logOff, kickOut } = useSessionBar({ onLoggedOff }, broker);
  return (
    <div className="session-bar">
      <span className="session-who">
        {who ?? "session"} <code>…{token.slice(-4)}</code>
      </span>
      <CopyButton text={token} title="copy bearer token — use it for your own requests" />
      <button className="btn ghost small" onClick={logOff}>
        log off
      </button>
      <button
        className="btn danger small"
        disabled={busy}
        title="revoke this token at the broker — dead everywhere"
        onClick={() => void kickOut()}
      >
        kick out
      </button>
      {onTeardown && (
        <button
          className="btn danger small"
          title="logout + teardown: close every agent in YOUR herdr session and stop it — the shared broker keeps running"
          onClick={() => void onTeardown()}
        >
          tear down my herdr
        </button>
      )}
    </div>
  );
}
