import type { BrokerClient, Screen, ScreenSource } from "@jefelabs/herdr-broker-client";
import { useEffect, useMemo, useState } from "react";
import { useBrokerOr } from "./context.js";

/** Live pane frames via the SDK's watchScreen long-poll loop — changed
 * frames only, auto-restarting when the pane or source changes, stopped
 * on unmount or live: false. Extracted from the PaneViewer organism,
 * which now consumes it. */
export function useScreen(
  opts: { instance: string; session: string; paneId: string; source?: ScreenSource; live?: boolean },
  brokerArg?: BrokerClient,
) {
  const broker = useBrokerOr(brokerArg);
  const source = opts.source ?? "visible";
  const live = opts.live ?? true;
  const [frame, setFrame] = useState<Screen | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agent = useMemo(
    () => broker.instance(opts.instance).session(opts.session).agent(opts.paneId),
    [broker, opts.instance, opts.session, opts.paneId],
  );

  useEffect(() => {
    if (!live) return;
    setError(null);
    return agent.watchScreen((s) => setFrame(s), { source, onError: (e) => setError(String(e)) });
  }, [agent, source, live]);

  return { frame, error };
}
