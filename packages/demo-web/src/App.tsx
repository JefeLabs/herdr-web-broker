import { AuthGate } from "@jefelabs/herdr-broker-ui";
import { useEffect, useState } from "react";
import { send } from "./api/client";
import { ApiSpec } from "./pages/ApiSpec";
import { Console } from "./pages/Console";
import { Intro } from "./pages/Intro";
import { WorkspacePage } from "./pages/Workspace";
import { SettingsProvider, useSettings } from "./settings";

const ROUTES = [
  { hash: "#/", label: "Intro" },
  { hash: "#/console", label: "Console" },
  { hash: "#/workspace", label: "Workspace" },
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
    <AuthGate broker={s.broker} token={s.bearer} onTokenChange={(t) => s.set("bearer", t)}>
      {children}
    </AuthGate>
  );
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
