import { expect, type Page } from "@playwright/test";

export const BEARER = "demo-token";
export const ADMIN = "e2e-admin"; // seeded by playwright.config.ts via BROKER_ADMIN_TOKEN
export const BROKER = "http://127.0.0.1:7591";

/** Pass the live auth gate on the given hash route. The gate re-verifies
 * stored tokens on mount, so a fresh context always starts here. */
export async function authenticate(page: Page, route: string, token = BEARER): Promise<void> {
  await page.goto(`/#/${route}`);
  await expect(page.getByRole("heading", { name: "Authentication required" })).toBeVisible();
  await page.getByLabel("bearer token").fill(token);
  await page.getByRole("button", { name: "authenticate" }).click();
  await expect(page.getByRole("heading", { name: "Authentication required" })).toBeHidden();
}

/** Direct broker call — for arranging state the UI flow doesn't cover. */
export async function brokerFetch(
  path: string,
  opts: { method?: string; token?: string; admin?: boolean; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BROKER}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.admin ? { "x-admin-token": ADMIN } : { authorization: `Bearer ${opts.token ?? BEARER}` }),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
