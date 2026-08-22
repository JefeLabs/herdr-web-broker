import type { BrokerClient, Screen, ScreenSource } from "@jefelabs/herdr-broker-client";
import { useCallback, useMemo, useState } from "react";
import { useBrokerOr } from "./context.js";
import { useScreen } from "./useScreen.js";

/** The live pane viewer's whole behavior: watchScreen frames (via
 * useScreen), the visible/recent source toggle, pause/resume, and the
 * write half — send() types the input buffer through pane.send_input
 * (Enter included), interrupt() sends Escape, the portable interrupt.
 * Skins render the terminal and the bar; this runs them. Extracted from
 * the PaneViewer organism, which now consumes it. */
export function usePaneViewer(
  opts: { instance: string; session: string; paneId: string },
  brokerArg?: BrokerClient,
): {
  frame: Screen | null;
  source: ScreenSource;
  setSource: (s: ScreenSource) => void;
  live: boolean;
  setLive: (v: boolean | ((v: boolean) => boolean)) => void;
  input: string;
  setInput: (v: string) => void;
  send: () => Promise<void>;
  interrupt: () => Promise<void>;
  error: string | null;
} {
  const broker = useBrokerOr(brokerArg);
  const agent = useMemo(
    () => broker.instance(opts.instance).session(opts.session).agent(opts.paneId),
    [broker, opts.instance, opts.session, opts.paneId],
  );
  const [source, setSource] = useState<ScreenSource>("visible");
  const [live, setLive] = useState(true);
  const [input, setInput] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const { frame, error: screenError } = useScreen(
    { instance: opts.instance, session: opts.session, paneId: opts.paneId, source, live },
    broker,
  );

  const send = useCallback(async () => {
    const text = input;
    if (!text.trim()) return;
    setInput("");
    try {
      await agent.type(text);
    } catch (e) {
      setActionError(String(e));
    }
  }, [agent, input]);

  const interrupt = useCallback(async () => {
    try {
      await agent.keys(["Escape"]);
    } catch (e) {
      setActionError(String(e));
    }
  }, [agent]);

  return {
    frame,
    source,
    setSource,
    live,
    setLive,
    input,
    setInput,
    send,
    interrupt,
    error: actionError ?? screenError,
  };
}
