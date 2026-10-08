import { defineConfig } from "@playwright/test";

import { origin as baseURL, port } from "./tests/instant/origin.ts";

/** `instant()` needs a production build compiled with the testing API; `next dev` gives no verdict. */
export default defineConfig({
  testDir: "tests/instant",
  testMatch: "*.instant.ts",
  forbidOnly: "CI" in process.env,
  // Store reads wait DEMO_LATENCY_MS (3 s by default); a cold page chains a few.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  use: { baseURL, browserName: "chromium" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `pnpm exec next build && pnpm exec next start -p ${port} -H 127.0.0.1`,
    url: `${baseURL}/api/health`,
    env: { EXPOSE_TESTING_API: "1", NEXT_TELEMETRY_DISABLED: "1" },
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
