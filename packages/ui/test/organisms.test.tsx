import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(cleanup);
import type { BrokerClient } from "@jefelabs/herdr-broker-client";
import { AuthGate } from "../src/organisms/AuthGate.js";
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
