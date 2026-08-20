import { expect, test } from "@playwright/test";
import { authenticate } from "./helpers";

/** The console's endpoint cards are live calls against the devstack broker
 * (real daemon, simulated herdr). Each card is article#<catalog id>. */
test.describe("console flows", () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page, "console");
  });

  async function send(page: import("@playwright/test").Page, cardId: string) {
    const card = page.locator(`article#${cardId}`);
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("button", { name: "send" }).click();
    return card;
  }

  test("health and instances round-trip with 200s", async ({ page }) => {
    const health = await send(page, "health");
    await expect(health.locator(".status-pill")).toContainText("200");
    await expect(health.locator(".codeview")).toContainText("herdr-web-broker");

    const instances = await send(page, "instances");
    await expect(instances.locator(".status-pill")).toContainText("200");
    await expect(instances.locator(".codeview")).toContainText("runtime");
  });

  test("agents lists the sim's panes with folded status", async ({ page }) => {
    const card = await send(page, "agents");
    await expect(card.locator(".status-pill")).toContainText("200");
    await expect(card.locator(".codeview")).toContainText("w1:p1");
    await expect(card.locator(".codeview")).toContainText("working");
  });

  test("spawn creates a pane; steering it answers prompted", async ({ page }) => {
    const spawn = page.locator("article#spawn");
    await spawn.scrollIntoViewIfNeeded();
    await spawn.getByLabel("kind", { exact: false }).first().fill("copilot");
    await spawn.getByLabel("cwd (mode A)").first().fill("/tmp");
    await spawn.getByRole("button", { name: "send" }).click();
    await expect(spawn.locator(".status-pill")).toContainText("201");
    await expect(spawn.locator(".codeview")).toContainText("pane_id");

    const prompt = page.locator("article#prompt");
    await prompt.scrollIntoViewIfNeeded();
    await prompt.getByLabel("pane_id", { exact: false }).first().fill("w1:p1");
    await prompt.getByLabel("text", { exact: false }).first().fill("focus on the tests");
    await prompt.getByRole("button", { name: "send" }).click();
    await expect(prompt.locator(".status-pill")).toContainText("200");
    await expect(prompt.locator(".codeview")).toContainText("prompted");
  });

  test("slash types the CLI's own command and answers sent", async ({ page }) => {
    const slash = page.locator("article#slash");
    await slash.scrollIntoViewIfNeeded();
    await slash.getByLabel("pane_id", { exact: false }).first().fill("w1:p1");
    await slash.getByLabel("command", { exact: false }).first().fill("clear");
    await slash.getByRole("button", { name: "send" }).click();
    await expect(slash.locator(".status-pill")).toContainText("200");
    await expect(slash.locator(".codeview")).toContainText("sent");
  });
});
