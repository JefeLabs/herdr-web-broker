import { defineConfig } from "@playwright/test";

/** e2e against the devstack: the REAL broker daemon riding the FakeHerdr
 * simulator (deterministic, no Docker), with the built site on vite
 * preview. Specs share one devstack, so they run serially; the kick spec
 * mints its own token rather than killing demo-token. Requires a prior
 * `vite build` (CI builds the workspace chain first). */
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node devstack.mjs",
      url: "http://127.0.0.1:7591/health",
      reuseExistingServer: false,
      env: { BROKER_ADMIN_TOKEN: "e2e-admin" },
      timeout: 30_000,
    },
    {
      command: "npm run preview",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
