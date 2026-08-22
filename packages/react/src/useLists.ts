import type { AgentInfo, BrokerClient, Workspace } from "@jefelabs/herdr-broker-client";
import { useCallback, useEffect, useState } from "react";
import { useBrokerOr } from "./context.js";

/** The session's agent roster, fresh-queried on mount and reloadable —
 * extracted from the demo's Pane page picker. */
export function useAgents(
  opts: { instance: string; session: string; fresh?: boolean; auto?: boolean },
  brokerArg?: BrokerClient,
) {
  const broker = useBrokerOr(brokerArg);
  const fresh = opts.fresh ?? true;
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setAgents(await broker.instance(opts.instance).session(opts.session).agents({ fresh }));
    } catch (e) {
      setAgents([]);
      setError(String(e));
    }
  }, [broker, opts.instance, opts.session, fresh]);

  const auto = opts.auto ?? true;
  useEffect(() => {
    if (auto) void reload();
  }, [auto, reload]);

  return { agents, error, reload };
}

/** The session's working sets (team roster + repos per workspace) —
 * extracted from the WorkspaceBrowser organism, which now consumes it. */
export function useWorkspaces(
  opts: { instance: string; session: string; auto?: boolean },
  brokerArg?: BrokerClient,
) {
  const broker = useBrokerOr(brokerArg);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setWorkspaces(await broker.instance(opts.instance).session(opts.session).workspaces());
      setLoaded(true);
    } catch (e) {
      setWorkspaces([]);
      setError(String(e));
    }
  }, [broker, opts.instance, opts.session]);

  const auto = opts.auto ?? true;
  useEffect(() => {
    if (auto) void reload();
  }, [auto, reload]);

  return { workspaces, error, loaded, reload };
}
