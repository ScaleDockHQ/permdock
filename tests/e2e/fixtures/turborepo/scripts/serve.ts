import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@permdock/e2e-saas-kit/serve';

const cwd = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_TOKEN = randomBytes(24).toString('base64url');

serve({
  cwd,
  build: { command: process.execPath, args: ['scripts/build.ts'] },
  servers: [
    {
      command: join(cwd, 'apps/web/node_modules/.bin/next'),
      args: ['start', 'apps/web', '-p', '3508', '-H', '127.0.0.1'],
      port: 3508,
      env: { NEXT_TELEMETRY_DISABLED: '1' },
    },
    {
      command: process.execPath,
      args: ['apps/api/src/server.ts'],
      port: 3509,
      env: { WORKER_TOKEN },
    },
    {
      command: process.execPath,
      args: ['apps/worker/src/worker.ts'],
      port: 0,
      env: { WORKER_TOKEN, API_ORIGIN: 'http://127.0.0.1:3509' },
    },
  ],
});
