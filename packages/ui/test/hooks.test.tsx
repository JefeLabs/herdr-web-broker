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
} from "../src/hooks/index.js";

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
