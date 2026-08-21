import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(cleanup);
import type { BrokerClient, Screen as PaneScreen } from "@jefelabs/herdr-broker-client";
import { AuthGate } from "../src/organisms/AuthGate.js";
import { EventsPanel } from "../src/organisms/EventsPanel.js";
import { PaneViewer } from "../src/organisms/PaneViewer.js";
import { SessionBar } from "../src/organisms/SessionBar.js";
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

describe("AuthGate re-lock", () => {
  test("clearing the token while unlocked drops straight back to the gate", async () => {
    const broker = {
      setToken: vi.fn(),
      verify: vi.fn(async () => ({ ok: true })),
    } as unknown as BrokerClient;
    const view = render(
      <AuthGate broker={broker} token="tok" onTokenChange={() => undefined}>
        <div>secret content</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.getByText("secret content")).toBeTruthy());
    view.rerender(
      <AuthGate broker={broker} token="" onTokenChange={() => undefined}>
        <div>secret content</div>
      </AuthGate>,
    );
    await waitFor(() => expect(screen.queryByText("secret content")).toBeNull());
    expect(screen.getByText("Authentication required")).toBeTruthy();
  });
});

describe("SessionBar", () => {
  test("masks the token, exposes copy, and 'log off' clears locally WITHOUT touching the broker", async () => {
    const broker = { signOut: vi.fn() } as unknown as BrokerClient;
    const onLoggedOff = vi.fn();
    render(<SessionBar broker={broker} token="secret-token-abcd" onLoggedOff={onLoggedOff} />);
    // masked display, never the full token in text
    expect(screen.getByText(/…abcd/)).toBeTruthy();
    expect(screen.queryByText("secret-token-abcd")).toBeNull();
    // the copy button carries the FULL token for subsequent requests
    expect((screen.getByTitle(/copy bearer token/i) as HTMLButtonElement)).toBeTruthy();
    fireEvent.click(screen.getByText("log off"));
    expect(onLoggedOff).toHaveBeenCalledOnce();
    expect(broker.signOut).not.toHaveBeenCalled();
  });

  test("'kick out' revokes at the broker, then clears locally — even if the revoke fails", async () => {
    const broker = {
      signOut: vi.fn(async () => ({ signed_out: "me", token_revoked: true, sockets_closed: 0 })),
    } as unknown as BrokerClient;
    const onLoggedOff = vi.fn();
    render(<SessionBar broker={broker} token="tok" onLoggedOff={onLoggedOff} />);
    fireEvent.click(screen.getByText("kick out"));
    await waitFor(() => expect(onLoggedOff).toHaveBeenCalledOnce());
    expect(broker.signOut).toHaveBeenCalledOnce();

    // a dead token 401s on signOut — local clear must still happen
    const dead = { signOut: vi.fn(async () => Promise.reject(new Error("unauthorized"))) } as unknown as BrokerClient;
    const off2 = vi.fn();
    render(<SessionBar broker={dead} token="tok2" onLoggedOff={off2} />);
    fireEvent.click(screen.getAllByText("kick out")[1]);
    await waitFor(() => expect(off2).toHaveBeenCalledOnce());
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

  test("a repo-less workspace hints at agent-driven git init instead of a bare empty list", async () => {
    const session = {
      workspaces: vi.fn(async () => [
        {
          workspace_id: "w2",
          cwd: "/fresh",
          agents: [{ agent: "copilot", pane_id: "w2:p1", status: "idle" }],
          repos: [],
        },
      ]),
      repo: vi.fn(),
    };
    const broker = { instance: () => ({ session: () => session }) } as unknown as BrokerClient;
    render(<WorkspaceBrowser broker={broker} instance="runtime" session="default" />);
    fireEvent.click(screen.getByText("load workspaces"));
    await waitFor(() => expect(screen.getByText("w2")).toBeTruthy());
    expect(screen.getByText(/ask your agent to git init/i)).toBeTruthy();
  });
});

describe("EventsPanel subscriptions", () => {
  function eventsMocks() {
    const handlers = new Map<string, Set<(data: unknown) => void>>();
    const unsub = vi.fn();
    let captured: {
      onEvent?: (name: string, data: unknown) => void;
      onClose?: (reason: string) => void;
    } = {};
    const events = {
      on: vi.fn((type: string, cb: (data: unknown) => void) => {
        let set = handlers.get(type);
        if (!set) handlers.set(type, (set = new Set()));
        set.add(cb);
        return () => set.delete(cb);
      }),
      connect: vi.fn(() => handlers.get("open")?.forEach((cb) => cb(undefined))),
      close: vi.fn(),
      rpc: vi.fn(async () => ({})),
      subscribe: vi.fn(async (_t: unknown, onEvent: (n: string, d: unknown) => void, onClose?: (r: string) => void) => {
        captured = { onEvent, onClose };
        return unsub;
      }),
    };
    const broker = { events } as unknown as BrokerClient;
    return { broker, events, unsub, fire: () => captured };
  }

  test("subscribe sends the parsed type list, streams herdr events into the log, unsubscribe stops", async () => {
    const { broker, events, unsub, fire } = eventsMocks();
    render(<EventsPanel broker={broker} instance="runtime" session="default" />);
    fireEvent.click(screen.getByText("connect"));

    fireEvent.change(screen.getByLabelText(/herdr subscriptions/i), {
      target: { value: "workspace.created, pane.created" },
    });
    fireEvent.click(screen.getByText("subscribe"));
    await waitFor(() => expect(events.subscribe).toHaveBeenCalled());
    expect(events.subscribe.mock.calls[0][0]).toEqual({
      instance: "runtime",
      session: "default",
      subscriptions: [{ type: "workspace.created" }, { type: "pane.created" }],
    });

    fire().onEvent!("pane_created", { pane: { pane_id: "w1:p2" } });
    await screen.findByText(/pane_created/);

    fireEvent.click(screen.getByText("unsubscribe"));
    expect(unsub).toHaveBeenCalled();

    // a server-side closure reaches the log as a system line
    fireEvent.click(screen.getByText("subscribe"));
    await waitFor(() => expect(events.subscribe).toHaveBeenCalledTimes(2));
    fire().onClose!("child disconnected");
    await screen.findByText(/child disconnected/);
  });
});
