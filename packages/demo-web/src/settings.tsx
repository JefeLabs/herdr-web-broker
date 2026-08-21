import { BrokerClient } from "@jefelabs/herdr-broker-client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { send } from "./api/client";

export interface Settings {
  bearer: string;
  admin: string;
  instance: string;
  session: string;
  instances: string[];
  sessions: string[];
  /** the shared interaction model — one client, token kept in sync */
  broker: BrokerClient;
  set(key: "bearer" | "admin" | "instance" | "session", value: string): void;
  /** re-pulls /instances and /instances/{i} to feed the instance/session pickers */
  refresh(): Promise<void>;
}

const SettingsCtx = createContext<Settings | null>(null);

const LS_KEY = "herdr-broker-demo";

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const stored = useMemo(load, []);
  // no default token: the auth gate must be passed explicitly on first visit
  const [bearer, setBearer] = useState(stored.bearer ?? "");
  const [admin, setAdmin] = useState(stored.admin ?? "");
  const [instance, setInstance] = useState(stored.instance ?? "runtime");
  const [session, setSession] = useState(stored.session ?? "default");
  const [instances, setInstances] = useState<string[]>([]);
  const [sessions, setSessions] = useState<string[]>([]);
  const broker = useMemo(() => new BrokerClient({ origin: "" }), []);

  useEffect(() => {
    broker.setToken(bearer);
  }, [broker, bearer]);

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify({ bearer, admin, instance, session }));
  }, [bearer, admin, instance, session]);

  const refresh = useCallback(async () => {
    const list = await send({ method: "GET", path: "/instances", auth: "bearer" }, { bearer });
    const rollup = (list.body as { instances?: { instance: string }[] })?.instances;
    if (Array.isArray(rollup)) setInstances(rollup.map((r) => r.instance));
    const detail = await send(
      { method: "GET", path: `/instances/${encodeURIComponent(instance)}`, auth: "bearer" },
      { bearer },
    );
    const names = (detail.body as { sessions?: string[] })?.sessions;
    if (Array.isArray(names)) setSessions(names);
  }, [bearer, instance]);

  useEffect(() => {
    refresh().catch(() => {
      // broker not up yet — pickers stay free-text
    });
  }, [refresh]);

  const set: Settings["set"] = (key, value) => {
    if (key === "bearer") setBearer(value);
    else if (key === "admin") setAdmin(value);
    else if (key === "instance") setInstance(value);
    else setSession(value);
  };

  const value: Settings = { bearer, admin, instance, session, instances, sessions, broker, set, refresh };
  return <SettingsCtx.Provider value={value}>{children}</SettingsCtx.Provider>;
}

export function useSettings(): Settings {
  const ctx = useContext(SettingsCtx);
  if (!ctx) throw new Error("useSettings outside SettingsProvider");
  return ctx;
}
