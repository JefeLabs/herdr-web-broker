import { expect, test } from "@playwright/test";
import { authenticate, BEARER, brokerFetch } from "./helpers";

test.describe("auth gate", () => {
  test("console and workspace are unreachable without a verified token", async ({ page }) => {
    for (const route of ["console", "workspace", "pane"]) {
      await page.goto(`/#/${route}`);
      await expect(page.getByRole("heading", { name: "Authentication required" })).toBeVisible();
      await expect(page.locator(".card-head")).toHaveCount(0);
    }
  });

  test("a wrong token shows the broker's live rejection, not a cached pass", async ({ page }) => {
    await page.goto("/#/console");
    await page.getByLabel("bearer token").fill("not-the-token");
    await page.getByLabel("your email").fill("wrong@e2e.local");
    await page.getByRole("button", { name: "authenticate" }).click();
    await expect(page.locator(".card-error")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeVisible();
  });

  test("the right token unlocks, and identity lands in /instances presence", async ({ page }) => {
    await page.goto("/#/console");
    await page.getByLabel("bearer token").fill("demo-token");
    await page.getByLabel("your name").fill("E2E Runner");
    await page.getByLabel("your email").fill("e2e@example.com");
    await page.getByRole("button", { name: "authenticate" }).click();
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeHidden();

    const parent = await brokerFetch("/instances");
    expect(parent.status).toBe(200);
    const inUse = (parent.body as { in_use_by: { name?: string; email?: string }[] }).in_use_by;
    expect(inUse.some((u) => u.name === "E2E Runner" && u.email === "e2e@example.com")).toBe(true);
  });

  test("self-serve: 'get a demo token' mints through the site server and unlocks without typing", async ({ page }) => {
    await page.goto("/#/console");
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeVisible();
    await page.getByLabel("your email").fill("selfserve@e2e.local");
    await page.getByRole("button", { name: "get a demo token" }).click();
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeHidden();
    await expect(page.locator("article#health")).toBeVisible();
  });

  test("session bar: log off keeps the token valid; kick out revokes it everywhere", async ({ page }) => {
    // in via self-serve mint — the bar appears in the topbar
    await page.goto("/#/console");
    await page.getByLabel("your email").fill("bar-flow@e2e.local");
    await page.getByRole("button", { name: "get a demo token" }).click();
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeHidden();
    await expect(page.getByRole("button", { name: "kick out" })).toBeVisible();

    const readToken = () =>
      page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
          try {
            const v = JSON.parse(localStorage.getItem(k) ?? "");
            if (typeof v.bearer === "string" && v.bearer) return v.bearer;
          } catch {}
        }
        return "";
      });

    // LOG OFF: local only — gate returns, but the token still authenticates
    const tokenA = await readToken();
    expect(tokenA).toBeTruthy();
    await page.getByRole("button", { name: "log off" }).click();
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeVisible();
    expect((await brokerFetch("/instances", { token: tokenA })).status).toBe(200);

    // KICK OUT: revoked at the broker — dead everywhere, gate returns
    await page.getByLabel("your email").fill("bar-flow-2@e2e.local");
    await page.getByRole("button", { name: "get a demo token" }).click();
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeHidden();
    const tokenB = await readToken();
    await page.getByRole("button", { name: "kick out" }).click();
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeVisible();
    expect((await brokerFetch("/instances", { token: tokenB })).status).toBe(401);
  });

  test("a stored token is re-verified on mount — possession is not authentication", async ({ page }) => {
    await authenticate(page, "console");
    // simulate the token dying between visits: replace it in storage only
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => localStorage.getItem(k)?.includes("demo-token"));
      if (key) localStorage.setItem(key, localStorage.getItem(key)!.replace("demo-token", "stale-token"));
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeVisible();
  });
});

test.describe("session ownership", () => {
  test("email provisions MY herdr; teardown demolishes it and the shared broker survives", async ({ page }) => {
    // keepSession: null — stay in the owned session this flow is about
    await authenticate(page, "console", BEARER, { email: "owner-e2e@e2e.local", keepSession: null });

    // the broker provisioned a real (simulated) herdr for this email
    const roster = await brokerFetch("/instances/runtime");
    const sessions = (roster.body as { sessions: string[] }).sessions;
    const owned = sessions.find((s) => s.startsWith("u-owner-e2e-"));
    expect(owned).toBeTruthy();

    // the topbar knows this session is mine: the destructive exit exists
    await expect(page.getByRole("button", { name: "tear down my herdr" })).toBeVisible();
    await page.getByRole("button", { name: "tear down my herdr" }).click();

    // teardown logs out: back at the gate…
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeVisible();
    // …and the herdr is gone from the roster while the shared broker lives on
    const after = await brokerFetch("/instances/runtime");
    expect((after.body as { sessions: string[] }).sessions).not.toContain(owned);
    expect((after.body as { sessions: string[] }).sessions).toContain("default");
  });
});
