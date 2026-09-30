import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@permdock/e2e-saas-kit/serve';

const cwd = join(dirname(fileURLToPath(import.meta.url)), '..');

serve({
  cwd,
  build: {
    command: join(cwd, 'node_modules/.bin/nuxt'),
    args: ['build'],
    env: { NUXT_TELEMETRY_DISABLED: '1' },
  },
  servers: [
    {
      command: process.execPath,
      args: ['.output/server/index.mjs'],
      port: 3501,
    },
  ],
});
