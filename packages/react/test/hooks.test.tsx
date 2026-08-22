import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(cleanup);
import type { BrokerClient, Screen as PaneScreen } from "@jefelabs/herdr-broker-client";
import {
  BrokerProvider,
  useAgents,
  useBroker,
  useEventChannel,
  useScreen,
  useVerify,
  useWorkspaces,
} from "../src/index.js";

const wrapperFor = (broker: BrokerClient) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <BrokerProvider broker={broker}>{children}</BrokerProvider>;
  };

describe("useBroker", () => {
  test("returns the provided client; throws helpfully outside a provider", () => {
    const broker = {} as BrokerClient;
    const { result } = renderHook(() => useBroker(), { wrapper: wrapperFor(broker) });
    expect(result.current).toBe(broker);
    expect(() => renderHook(() => useBroker())).toThrow(/BrokerProvider/);
  });
});

describe("useVerify", () => {
  test("verifies on mount, exposes denied + error, and re-verifies through verify()", async () => {
    const broker = {
      setToken: vi.fn(),
      verify: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: { message: "missing or invalid bearer token" } })
        .mockResolvedValue({ ok: true }),
    } as unknown as BrokerClient;
    const { result } = renderHook(() => useVerify("bad"), { wrapper: wrapperFor(broker) });
    await waitFor(() => expect(result.current.state).toBe("denied"));
    expect(result.current.error).toMatch(/bearer token/);

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.verify("good");
    });
    expect(ok).toBe(true);
    expect(result.current.state).toBe("ok");
    expect((broker.setToken as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe("good");
  });

  test("an emptied token re-locks immediately — no token means not authenticated", async () => {
    const broker = { setToken: vi.fn(), verify: vi.fn(async () => ({ ok: true })) } as unknown as BrokerClient;
    const { result, rerender } = renderHook(({ token }) => useVerify(token), {
      wrapper: wrapperFor(broker),
      initialProps: { token: "tok" },
    });
    await waitFor(() => expect(result.current.state).toBe("ok"));
    rerender({ token: "" });
    await waitFor(() => expect(result.current.state).toBe("denied"));
  });
});

describe("useScreen", () => {
  function screenMocks() {
    const stop = vi.fn();
    const watchScreen = vi.fn((cb: (s: PaneScreen) => void) => {
      cb({ pane_id: "w1:p1", source: "visible", text: "hello", version: "v1", as_of: "now" });
      return stop;
    });
    const broker = {
      instance: () => ({ session: () => ({ agent: () => ({ watchScreen }) }) }),
    } as unknown as BrokerClient;
    return { broker, watchScreen, stop };
  }

  test("streams frames while live, stops on unmount, restarts when source changes", async () => {
    const { broker, watchScreen, stop } = screenMocks();
    const { result, rerender, unmount } = renderHook(
      ({ source }) => useScreen({ instance: "runtime", session: "default", paneId: "w1:p1", source }),
      { wrapper: wrapperFor(broker), initialProps: { source: "visible" as "visible" | "recent" } },
    );
    await waitFor(() => expect(result.current.frame?.text).toBe("hello"));
    rerender({ source: "recent" });
    await waitFor(() => expect(watchScreen).toHaveBeenCalledTimes(2));
    expect(watchScreen.mock.calls[1][1]).toMatchObject({ source: "recent" });
    unmount();
    expect(stop).toHaveBeenCalled();
  });

  test("live: false holds the loop entirely", async () => {
    const { broker, watchScreen } = screenMocks();
    renderHook(() => useScreen({ instance: "runtime", session: "default", paneId: "w1:p1", live: false }), {
      wrapper: wrapperFor(broker),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(watchScreen).not.toHaveBeenCalled();
  });
});

describe("useAgents / useWorkspaces", () => {
  test("useAgents loads fresh on mount and reloads on demand", async () => {
    const agents = vi.fn(async () => [{ id: "w1:p1", title: "Copilot", status: "idle" }]);
    const broker = { instance: () => ({ session: () => ({ agents }) }) } as unknown as BrokerClient;
    const { result } = renderHook(() => useAgents({ instance: "runtime", session: "default" }), {
      wrapper: wrapperFor(broker),
    });
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    expect(agents).toHaveBeenCalledWith({ fresh: true });
    await act(async () => {
      await result.current.reload();
    });
    expect(agents).toHaveBeenCalledTimes(2);
  });

  test("auto: false holds the initial load — the caller drives via reload()", async () => {
    const agents = vi.fn(async () => []);
    const broker = { instance: () => ({ session: () => ({ agents }) }) } as unknown as BrokerClient;
    renderHook(() => useAgents({ instance: "runtime", session: "default", auto: false }), {
      wrapper: wrapperFor(broker),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(agents).not.toHaveBeenCalled();
  });

  test("useWorkspaces surfaces errors instead of swallowing them", async () => {
    const workspaces = vi.fn(async () => {
      throw new Error("instance_offline");
    });
    const broker = { instance: () => ({ session: () => ({ workspaces }) }) } as unknown as BrokerClient;
    const { result } = renderHook(() => useWorkspaces({ instance: "runtime", session: "default" }), {
      wrapper: wrapperFor(broker),
    });
    await waitFor(() => expect(result.current.error).toMatch(/instance_offline/));
    expect(result.current.workspaces).toEqual([]);
  });
});

describe("useEventChannel", () => {
  test("tracks connection state through the channel's open/close events", async () => {
    const handlers = new Map<string, (e?: unknown) => void>();
    const channel = {
      on: vi.fn((ev: string, cb: (e?: unknown) => void) => {
        handlers.set(ev, cb);
        return () => handlers.delete(ev);
      }),
      connect: vi.fn(),
      close: vi.fn(),
    };
    const broker = { events: channel } as unknown as BrokerClient;
    const { result, unmount } = renderHook(() => useEventChannel(), { wrapper: wrapperFor(broker) });
    expect(result.current.connected).toBe(false);
    act(() => handlers.get("open")?.());
    expect(result.current.connected).toBe(true);
    act(() => handlers.get("close")?.());
    expect(result.current.connected).toBe(false);
    act(() => result.current.connect());
    expect(channel.connect).toHaveBeenCalled();
    unmount();
    expect(handlers.size).toBe(0);
  });
});

describe("useAuthGate", () => {
  test("requestToken mints, hands the token to the host, and verifies it", async () => {
    const { useAuthGate } = await import("../src/index.js");
    const broker = { setToken: vi.fn(), verify: vi.fn(async () => ({ ok: true })) } as unknown as BrokerClient;
    const onTokenChange = vi.fn();
    const { result } = renderHook(
      () => useAuthGate({ token: "", onTokenChange, onRequestToken: async () => "minted-tok" }),
      { wrapper: wrapperFor(broker) },
    );
    await act(async () => result.current.requestToken());
    expect(onTokenChange).toHaveBeenCalledWith("minted-tok");
    expect((broker.setToken as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe("minted-tok");
    await waitFor(() => expect(result.current.state).toBe("ok"));
  });

  test("a failed mint surfaces its error without touching the token", async () => {
    const { useAuthGate } = await import("../src/index.js");
    const broker = {
      setToken: vi.fn(),
      verify: vi.fn(async () => ({ ok: false, error: { message: "nope" } })),
    } as unknown as BrokerClient;
    const onTokenChange = vi.fn();
    const { result } = renderHook(
      () =>
        useAuthGate({
          token: "",
          onTokenChange,
          onRequestToken: async () => {
            throw new Error("mint disabled");
          },
        }),
      { wrapper: wrapperFor(broker) },
    );
    await act(async () => result.current.requestToken());
    expect(result.current.error).toBe("mint disabled");
    expect(onTokenChange).not.toHaveBeenCalled();
  });
});

describe("useSessionBar", () => {
  test("kickOut revokes at the broker then clears locally — even when the revoke fails", async () => {
    const { useSessionBar } = await import("../src/index.js");
    const signOut = vi.fn(async () => {
      throw new Error("already dead");
    });
    const broker = { signOut } as unknown as BrokerClient;
    const onLoggedOff = vi.fn();
    const { result } = renderHook(() => useSessionBar({ onLoggedOff }), { wrapper: wrapperFor(broker) });
    await act(async () => result.current.kickOut());
    expect(signOut).toHaveBeenCalled();
    expect(onLoggedOff).toHaveBeenCalled();

    result.current.logOff();
    expect(onLoggedOff).toHaveBeenCalledTimes(2);
    expect(signOut).toHaveBeenCalledTimes(1); // log off never touches the broker
  });
});

describe("usePaneViewer", () => {
  test("send types the buffer and clears it; interrupt sends Escape; frames flow", async () => {
    const { usePaneViewer } = await import("../src/index.js");
    const agent = {
      watchScreen: vi.fn((cb: (s: PaneScreen) => void) => {
        cb({ pane_id: "w1:p1", source: "visible", text: "❯ _", version: "v1", as_of: "now" });
        return () => undefined;
      }),
      type: vi.fn(async () => undefined),
      keys: vi.fn(async () => undefined),
    };
    const broker = { instance: () => ({ session: () => ({ agent: () => agent }) }) } as unknown as BrokerClient;
    const { result } = renderHook(() => usePaneViewer({ instance: "runtime", session: "default", paneId: "w1:p1" }), {
      wrapper: wrapperFor(broker),
    });
    await waitFor(() => expect(result.current.frame?.version).toBe("v1"));

    act(() => result.current.setInput("y"));
    await act(async () => result.current.send());
    expect(agent.type).toHaveBeenCalledWith("y");
    expect(result.current.input).toBe("");

    await act(async () => result.current.interrupt());
    expect(agent.keys).toHaveBeenCalledWith(["Escape"]);
  });
});

describe("useRepoBrowser", () => {
  test("load fetches on demand; browse fetches tree and diff for the picked repo", async () => {
    const { useRepoBrowser } = await import("../src/index.js");
    const repo = {
      tree: vi.fn(async () => ({ tree: { name: "app", type: "dir", children: [] }, truncated: false })),
      diff: vi.fn(async () => ({ branch: "main", status: [], diff: "", truncated: false })),
    };
    const session = {
      workspaces: vi.fn(async () => [{ workspace_id: "w1", cwd: "/work", agents: [], repos: [] }]),
      repo: vi.fn(() => repo),
    };
    const broker = { instance: () => ({ session: () => session }) } as unknown as BrokerClient;
    const { result } = renderHook(() => useRepoBrowser({ instance: "runtime", session: "default" }), {
      wrapper: wrapperFor(broker),
    });
    expect(session.workspaces).not.toHaveBeenCalled(); // on demand, never auto

    await act(async () => result.current.load());
    expect(result.current.workspaces.length).toBe(1);

    act(() => result.current.setBase("origin/main"));
    await act(async () => result.current.browse("w1", "app"));
    expect(session.repo).toHaveBeenCalledWith("w1", "app");
    expect(repo.diff).toHaveBeenCalledWith("origin/main");
    await waitFor(() => expect(result.current.tree).not.toBeNull());
    expect(result.current.diff?.branch).toBe("main");
  });
});

describe("useEventsPanel", () => {
  test("subscribe parses the csv, streams ⚡ lines into the log, unsubscribe records it", async () => {
    const { useEventsPanel } = await import("../src/index.js");
    let captured: { onEvent?: (n: string, d: unknown) => void } = {};
    const unsub = vi.fn();
    const events = {
      on: vi.fn(() => () => undefined),
      connect: vi.fn(),
      close: vi.fn(),
      subscribe: vi.fn(async (_t: unknown, onEvent: (n: string, d: unknown) => void) => {
        captured = { onEvent };
        return unsub;
      }),
    };
    const broker = { events } as unknown as BrokerClient;
    const { result } = renderHook(() => useEventsPanel({ instance: "runtime", session: "default" }), {
      wrapper: wrapperFor(broker),
    });
    await act(async () => result.current.subscribe("workspace.created, pane.created"));
    expect(events.subscribe.mock.calls[0][0]).toEqual({
      instance: "runtime",
      session: "default",
      subscriptions: [{ type: "workspace.created" }, { type: "pane.created" }],
    });
    expect(result.current.subscribed).toBe(true);

    act(() => captured.onEvent!("pane_created", { pane: { pane_id: "w1:p2" } }));
    expect(result.current.log.some((l) => l.text.startsWith("⚡ pane_created"))).toBe(true);

    act(() => result.current.unsubscribe());
    expect(unsub).toHaveBeenCalled();
    expect(result.current.subscribed).toBe(false);
    expect(result.current.log.at(-1)?.text).toBe("unsubscribed");
  });
});
