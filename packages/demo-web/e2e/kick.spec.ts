import { expect, test } from "@playwright/test";
import { brokerFetch } from "./helpers";

/** Full eviction lifecycle on a MINTED token, so demo-token (which the
 * other specs use) survives: mint → authenticate → kick → the token is
 * dead and the gate refuses the stored value on the next visit. */
test("kick revokes the token and the gate refuses it on reload", async ({ page }) => {
  const minted = await brokerFetch("/admin/tokens", { method: "POST", admin: true, body: { name: "e2e-victim" } });
  expect(minted.status).toBe(200);
  const token = (minted.body as { token: string }).token;
  expect(token).toBeTruthy();

  await page.goto("/#/console");
  await page.getByLabel("bearer token").fill(token);
  await page.getByRole("button", { name: "authenticate" }).click();
  await expect(page.getByRole("heading", { name: "Authentication required" })).toBeHidden();

  const kicked = await brokerFetch("/admin/kick/e2e-victim", { method: "POST", admin: true });
  expect(kicked.status).toBe(200);

  // the token is dead at the API…
  const after = await brokerFetch("/parent", { token });
  expect(after.status).toBe(401);

  // …and the gate re-verifies the stored token on mount, so reload lands
  // back at "Authentication required" instead of trusting storage.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Authentication required" })).toBeVisible();
});
