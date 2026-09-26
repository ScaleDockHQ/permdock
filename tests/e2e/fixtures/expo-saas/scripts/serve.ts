import { serve } from '@permdock/e2e-saas-kit/serve';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = join(dirname(fileURLToPath(import.meta.url)), '..');

serve({
  cwd,
  build: {
    command: join(cwd, 'node_modules/.bin/expo'),
    args: ['export', '--platform', 'web', '--output-dir', 'dist'],
    env: { NODE_ENV: 'production', EXPO_NO_TELEMETRY: '1', CI: '1' },
  },
  servers: [
    { command: process.execPath, args: ['scripts/start.ts'], port: 3504 },
  ],
});
