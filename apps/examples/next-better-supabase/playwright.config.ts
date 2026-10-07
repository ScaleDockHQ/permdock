import { defineConfig } from "@playwright/test";

// Not the dev or `serve` port, so neither answers for the measured build.
const port = 3589;
const baseURL = `http://127.0.0.1:${port}`;

/**
 * `instant()` needs a production build compiled with the testing API. `serve`
 * starts Postgres in Docker, then runs `next build` and `next start`.
 */
export default defineConfig({
  testDir: "tests/instant",
  testMatch: "*.instant.ts",
  forbidOnly: "CI" in process.env,
  reporter: "list",
  use: { baseURL, browserName: "chromium" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "node scripts/serve.ts",
    url: `${baseURL}/api/health`,
    env: {
      EXPOSE_TESTING_API: "1",
      PORT: String(port),
    },
    reuseExistingServer: false,
    // `serve` stops the Postgres container on SIGTERM.
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
    timeout: 400_000,
  },
});
