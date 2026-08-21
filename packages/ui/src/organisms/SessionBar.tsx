import type { BrokerClient } from "@jefelabs/herdr-broker-client";
import { useState } from "react";
import { CopyButton } from "../atoms/CopyButton.js";

export interface SessionBarProps {
  broker: BrokerClient;
  token: string;
  /** display identity; falls back to a generic "session" label */
  who?: string;
  /** clear the locally-stored token — the host owns storage */
  onLoggedOff: () => void;
}

/** Post-login session controls: the bearer rides every request, so the bar
 * surfaces it (masked, copy for curl/Postman/SDK use) with two exits —
 * "log off" forgets it locally (still valid elsewhere), "kick out"
 * self-evicts at the broker (DELETE /parent/auth: token revoked, sockets
 * closed, presence cleared) and then forgets it. A failed revoke (already
 * dead) still clears locally. */
export function SessionBar({ broker, token, who, onLoggedOff }: SessionBarProps) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="session-bar">
      <span className="session-who">
        {who ?? "session"} <code>…{token.slice(-4)}</code>
      </span>
      <CopyButton text={token} title="copy bearer token — use it for your own requests" />
      <button className="btn ghost small" onClick={onLoggedOff}>
        log off
      </button>
      <button
        className="btn danger small"
        disabled={busy}
        title="revoke this token at the broker — dead everywhere"
        onClick={() =>
          void (async () => {
            setBusy(true);
            try {
              await broker.signOut();
            } catch {
              // token already dead upstream — clearing locally is still right
            }
            onLoggedOff();
          })()
        }
      >
        kick out
      </button>
    </div>
  );
}
