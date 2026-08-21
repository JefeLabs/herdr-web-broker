import { AuthGate, SessionBar } from "@jefelabs/herdr-broker-ui";
import { useEffect, useState } from "react";
import { send } from "./api/client";
import { ApiSpec } from "./pages/ApiSpec";
import { Console } from "./pages/Console";
import { Intro } from "./pages/Intro";
import { PanePage } from "./pages/Pane";
import { WorkspacePage } from "./pages/Workspace";
import { SettingsProvider, useSettings } from "./settings";

const ROUTES = [
  { hash: "#/", label: "Intro" },
  { hash: "#/console", label: "Console" },
  { hash: "#/workspace", label: "Workspace" },
  { hash: "#/pane", label: "Pane" },
  { hash: "#/api", label: "API Spec" },
] as const;

function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

/** Bridges app state (settings context) into the ui package's AuthGate. */
function Gated({ children }: { children: React.ReactNode }) {
  const s = useSettings();
  return (
    <AuthGate
      broker={s.broker}
      token={s.bearer}
      onTokenChange={(t) => s.set("bearer", t)}
      onIdentify={(id) => s.broker.identify(id)}
      onRequestToken={async () => {
        // dev-only self-serve: the site server holds the admin secret and
        // forwards to POST /admin/tokens — see demoMint() in vite.config.ts
        const res = await fetch("/demo/mint", { method: "POST" });
        const body = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
        if (!res.ok || typeof body.token !== "string") {
          throw new Error(body.message ?? "self-serve minting is not enabled on this deployment");
        }
        return body.token;
      }}
    >
      {children}
    </AuthGate>
  );
}

/** Topbar session controls — visible whenever a bearer is stored: copy the
 * token for your own requests, log off (local), or kick out (revoke). */
function TopbarSession() {
  const s = useSettings();
  if (!s.bearer) return null;
  return <SessionBar broker={s.broker} token={s.bearer} onLoggedOff={() => s.set("bearer", "")} />;
}

function useBrokerHealth(): boolean | null {
  const [up, setUp] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const probe = () =>
      send({ method: "GET", path: "/health", auth: "none" }, {})
        .then((r) => alive && setUp(r.ok))
        .catch(() => alive && setUp(false));
    void probe();
    const t = setInterval(probe, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return up;
}

export function App() {
  const route = useHashRoute();
  const health = useBrokerHealth();

  return (
    <SettingsProvider>
      <header className="topbar">
        <span className="wordmark">
          herdr<b>∷</b>web-broker
        </span>
        <nav>
          {ROUTES.map((r) => (
            <a key={r.hash} href={r.hash} className={route === r.hash ? "active" : ""}>
              {r.label}
            </a>
          ))}
        </nav>
        <TopbarSession />
        <span className="health-dot" title="GET /health, polled every 10s">
          <span className={`dot ${health === null ? "" : health ? "on" : "off"}`} />
          {health === null ? "probing" : health ? "broker up" : "broker down"}
        </span>
      </header>
      {route === "#/console" ? (
        <Gated>
          <Console />
        </Gated>
      ) : route === "#/workspace" ? (
        <Gated>
          <WorkspacePage />
        </Gated>
      ) : route === "#/pane" ? (
        <Gated>
          <PanePage />
        </Gated>
      ) : route === "#/api" ? (
        <ApiSpec />
      ) : (
        <Intro />
      )}
      <footer className="site">
        herdr-web-broker v0.1.0 demo · every panel on this site is a live call — nothing is mocked
      </footer>
    </SettingsProvider>
  );
}
