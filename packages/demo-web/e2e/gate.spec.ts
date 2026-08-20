import { expect, test } from "@playwright/test";
import { authenticate, brokerFetch } from "./helpers";

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
    await page.getByRole("button", { name: "authenticate" }).click();
    await expect(page.locator(".card-error")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeVisible();
  });

  test("the right token unlocks, and identity lands in /parent presence", async ({ page }) => {
    await page.goto("/#/console");
    await page.getByLabel("bearer token").fill("demo-token");
    await page.getByLabel("your name").fill("E2E Runner");
    await page.getByLabel("your email").fill("e2e@example.com");
    await page.getByRole("button", { name: "authenticate" }).click();
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeHidden();

    const parent = await brokerFetch("/parent");
    expect(parent.status).toBe(200);
    const inUse = (parent.body as { in_use_by: { name?: string; email?: string }[] }).in_use_by;
    expect(inUse.some((u) => u.name === "E2E Runner" && u.email === "e2e@example.com")).toBe(true);
  });

  test("self-serve: 'get a demo token' mints through the site server and unlocks without typing", async ({ page }) => {
    await page.goto("/#/console");
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeVisible();
    await page.getByRole("button", { name: "get a demo token" }).click();
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeHidden();
    await expect(page.locator("article#health")).toBeVisible();
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
