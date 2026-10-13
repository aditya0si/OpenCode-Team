import { defineConfig, devices } from "@playwright/test";

const ROOT_PORT = 4174;
const PROJECT_PORT = 4175;
const ROOT_BASE = `http://127.0.0.1:${ROOT_PORT}/`;
const PROJECT_BASE = `http://127.0.0.1:${PROJECT_PORT}/OpenCode-Team/`;

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.mjs/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  outputDir: "./test-results/playwright",
  globalSetup: "./scripts/global-setup.mjs",
  use: {
    ...devices["Desktop Chrome"],
    screenshot: "only-on-failure",
    trace: "off",
  },
  webServer: [
    {
      command: "node scripts/serve.mjs",
      url: ROOT_BASE,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { ...process.env, SERVE_BASE: "/", SERVE_PORT: String(ROOT_PORT) },
    },
    {
      command: "node scripts/serve.mjs",
      url: PROJECT_BASE,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { ...process.env, SERVE_BASE: "/OpenCode-Team/", SERVE_PORT: String(PROJECT_PORT) },
    },
  ],
  projects: [
    {
      name: "desktop-root",
      use: { baseURL: ROOT_BASE, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "desktop-project",
      use: { baseURL: PROJECT_BASE, viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-root",
      use: { baseURL: ROOT_BASE, viewport: { width: 375, height: 720 } },
    },
    {
      name: "mobile-project",
      use: { baseURL: PROJECT_BASE, viewport: { width: 375, height: 720 } },
    },
  ],
});
