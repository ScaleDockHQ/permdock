import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const port = process.env.E2E_PORT ?? '3456';
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const inCi = Boolean(process.env.CI);

function webServerEnv(): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  env.PORT = port;
  return env;
}

export default defineConfig({
  testDir: './src',
  fullyParallel: true,
  forbidOnly: inCi,
  retries: inCi ? 2 : 0,
  reporter: inCi ? 'github' : 'list',
  use: {
    baseURL,
  },
  webServer: {
    command: `pnpm --filter @permdock/example-hono start`,
    cwd: root,
    url: `${baseURL}/health`,
    reuseExistingServer: !inCi,
    timeout: 30_000,
    env: webServerEnv(),
  },
});
