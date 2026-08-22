import { expect, type Page } from "@playwright/test";

export const BEARER = "demo-token";
export const ADMIN = "e2e-admin"; // seeded by playwright.config.ts via BROKER_ADMIN_TOKEN
export const BROKER = "http://127.0.0.1:7591";

/** Pass the live auth gate on the given hash route. The gate re-verifies
 * stored tokens on mount, so a fresh context always starts here. Email is
 * required (session ownership) — each token gets a stable derived email so
 * bindings never conflict across specs. Identify moves the app into the
 * caller's OWNED session; suites built on the rich shared "default" sim
 * steer back via keepSession: "default" (the default here). */
export async function authenticate(
  page: Page,
  route: string,
  token = BEARER,
  opts: { email?: string; keepSession?: string | null } = {},
): Promise<void> {
  const email = opts.email ?? `${token.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "user"}@e2e.local`;
  await page.goto(`/#/${route}`);
  await expect(page.getByRole("heading", { name: "Authentication required" })).toBeVisible();
  await page.getByLabel("bearer token").fill(token);
  await page.getByLabel("your email").fill(email);
  await page.getByRole("button", { name: "authenticate" }).click();
  await expect(page.getByRole("heading", { name: "Authentication required" })).toBeHidden();
  const keep = opts.keepSession === undefined ? "default" : opts.keepSession;
  if (keep !== null) {
    // pin the app back onto the named session; the stored token re-verifies
    // on reload without re-identifying, so the choice sticks
    await page.evaluate(
      ([key, session]) => {
        const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, string>;
        stored.session = session;
        localStorage.setItem(key, JSON.stringify(stored));
      },
      ["herdr-broker-demo", keep] as const,
    );
    await page.reload();
    await expect(page.getByRole("heading", { name: "Authentication required" })).toBeHidden();
  }
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
