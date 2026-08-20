import { expect, test } from "@playwright/test";
import { authenticate } from "./helpers";

/** The live pane viewer against the sim: pane.read answers with a heartbeat
 * that ticks every ~3s, so the long-poll has real changes to deliver. */
test.describe("pane viewer", () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page, "pane");
  });

  test("streams frames: first frame renders, the version advances on change", async ({ page }) => {
    await expect(page.getByRole("combobox", { name: "pane" })).toContainText("w1:p1");
    const screen = page.locator(".term-screen");
    await expect(screen).toContainText("user@sim", { timeout: 10_000 });

    const version = page.locator(".term-status span").first();
    await expect(version).toContainText("v ");
    const v1 = await version.textContent();
    // the sim ticks every ~3s; the long-poll must deliver a NEW version
    await expect(version).not.toHaveText(v1!, { timeout: 10_000 });
  });

  test("pause freezes the loop; resume restarts it", async ({ page }) => {
    await expect(page.locator(".term-screen")).toContainText("user@sim", { timeout: 10_000 });
    await page.getByRole("button", { name: "pause" }).click();
    await expect(page.getByText("▯ paused")).toBeVisible();
    await page.getByRole("button", { name: "resume" }).click();
    await expect(page.getByText("▮ live")).toBeVisible();
  });

  test("the input bar sends text into the pane and clears on success", async ({ page }) => {
    await expect(page.locator(".term-screen")).toContainText("user@sim", { timeout: 10_000 });
    const input = page.getByPlaceholder(/type into the pane/);
    await input.fill("echo hello");
    await page.getByRole("button", { name: "send", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(page.locator(".term-error")).toHaveCount(0);
  });
});
