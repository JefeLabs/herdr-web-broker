import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(cleanup);
import type { BrokerClient, Screen as PaneScreen } from "@jefelabs/herdr-broker-client";
import { AuthGate } from "../src/organisms/AuthGate.js";
import { PaneViewer } from "../src/organisms/PaneViewer.js";
import { WorkspaceBrowser } from "../src/organisms/WorkspaceBrowser.js";

describe("AuthGate", () => {
  test("renders children only after a live verify succeeds", async () => {
    const broker = {
      setToken: vi.fn(),
      verify: vi.fn(async () => ({ ok: true })),
    } as unknown as BrokerClient;
    render(
      <AuthGate broker={broker} token="tok" onTokenChange={() => undefined}>
        <div>secret content</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText("secret content")).toBeTruthy());
    expect((broker.setToken as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("tok");
  });

  test("shows the broker's rejection and keeps children hidden", async () => {
    const broker = {
      setToken: vi.fn(),
      verify: vi.fn(async () => ({ ok: false, error: { message: "missing or invalid bearer token" } })),
    } as unknown as BrokerClient;
    render(
      <AuthGate broker={broker} token="bad" onTokenChange={() => undefined}>
        <div>secret content</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText("missing or invalid bearer token")).toBeTruthy());
    expect(screen.queryByText("secret content")).toBeNull();
  });
});

describe("AuthGate self-serve token", () => {
  test("the get-a-token button mints, fills, verifies, and unlocks", async () => {
    const broker = {
      setToken: vi.fn(),
      verify: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: { message: "missing or invalid bearer token" } })
        .mockResolvedValue({ ok: true }),
    } as unknown as BrokerClient;
    const onRequestToken = vi.fn(async () => "minted-tok");
    const onTokenChange = vi.fn();
    render(
      <AuthGate broker={broker} token="" onTokenChange={onTokenChange} onRequestToken={onRequestToken}>
        <div>secret content</div>
      </AuthGate>,
    );
    const btn = await screen.findByText("get a demo token");
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText("secret content")).toBeTruthy());
    expect(onRequestToken).toHaveBeenCalledOnce();
    expect(onTokenChange).toHaveBeenCalledWith("minted-tok");
    expect((broker.setToken as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe("minted-tok");
  });

  test("a failed mint shows its error and keeps the gate shut", async () => {
    const broker = {
      setToken: vi.fn(),
      verify: vi.fn(async () => ({ ok: false, error: { message: "missing or invalid bearer token" } })),
    } as unknown as BrokerClient;
    const onRequestToken = vi.fn(async () => {
      throw new Error("token minting is disabled");
    });
    render(
      <AuthGate broker={broker} token="" onTokenChange={() => undefined} onRequestToken={onRequestToken}>
        <div>secret content</div>
      </AuthGate>,
    );
    fireEvent.click(await screen.findByText("get a demo token"));
    await waitFor(() => expect(screen.getByText(/token minting is disabled/)).toBeTruthy());
    expect(screen.queryByText("secret content")).toBeNull();
  });

  test("without onRequestToken the button does not exist", async () => {
    const broker = {
      setToken: vi.fn(),
      verify: vi.fn(async () => ({ ok: false, error: { message: "nope" } })),
    } as unknown as BrokerClient;
    render(
      <AuthGate broker={broker} token="" onTokenChange={() => undefined}>
        <div>secret content</div>
      </AuthGate>,
    );
    await screen.findByText("authenticate");
    expect(screen.queryByText("get a demo token")).toBeNull();
  });
});

describe("PaneViewer", () => {
  function paneMocks() {
    const stop = vi.fn();
    const agent = {
      watchScreen: vi.fn((cb: (s: PaneScreen) => void) => {
        cb({ pane_id: "w1:p1", source: "visible", text: "❯ npm test ▌", version: "v1", as_of: "now" });
        return stop;
      }),
      type: vi.fn(async () => undefined),
      keys: vi.fn(async () => undefined),
    };
    const broker = {
      instance: () => ({ session: () => ({ agent: () => agent }) }),
    } as unknown as BrokerClient;
    return { broker, agent, stop };
  }

  test("streams frames live on mount and stops the watch on unmount", async () => {
    const { broker, agent, stop } = paneMocks();
    const view = render(<PaneViewer broker={broker} instance="runtime" session="default" paneId="w1:p1" />);
    await waitFor(() => expect(screen.getByText(/npm test/)).toBeTruthy());
    expect(agent.watchScreen).toHaveBeenCalledOnce();
    view.unmount();
    expect(stop).toHaveBeenCalled();
  });

  test("the recent toggle restarts the watch with source=recent", async () => {
    const { broker, agent } = paneMocks();
    render(<PaneViewer broker={broker} instance="runtime" session="default" paneId="w1:p1" />);
    fireEvent.click(screen.getByText("recent"));
    await waitFor(() => expect(agent.watchScreen).toHaveBeenCalledTimes(2));
    expect(agent.watchScreen.mock.calls[1][1]).toMatchObject({ source: "recent" });
  });

  test("the input bar types into the pane and Esc sends the interrupt key", async () => {
    const { broker, agent } = paneMocks();
    render(<PaneViewer broker={broker} instance="runtime" session="default" paneId="w1:p1" />);
    const input = screen.getByPlaceholderText(/type into the pane/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.click(screen.getByText("send"));
    await waitFor(() => expect(agent.type).toHaveBeenCalledWith("1"));
    expect(input.value).toBe("");
    fireEvent.click(screen.getByText("Esc"));
    await waitFor(() => expect(agent.keys).toHaveBeenCalledWith(["Escape"]));
  });
});

describe("WorkspaceBrowser", () => {
  test("loads workspaces through the session handle and renders repos", async () => {
    const session = {
      workspaces: vi.fn(async () => [
        {
          workspace_id: "w1",
          cwd: "/work",
          label: "demo team",
          agents: [{ agent: "copilot", pane_id: "w1:p1", status: "working" }],
          repos: [{ name: "app", path: "app", branch: "main", dirty: true }],
        },
      ]),
      repo: vi.fn(),
    };
    const broker = { instance: () => ({ session: () => session }) } as unknown as BrokerClient;
    render(<WorkspaceBrowser broker={broker} instance="runtime" session="default" />);
    fireEvent.click(screen.getByText("load workspaces"));
    await waitFor(() => expect(screen.getByText("w1")).toBeTruthy());
    expect(screen.getAllByText("app").length).toBeGreaterThan(0);
    expect(screen.getByText("● DIRTY")).toBeTruthy();
    expect(session.workspaces).toHaveBeenCalledOnce();
  });
});
