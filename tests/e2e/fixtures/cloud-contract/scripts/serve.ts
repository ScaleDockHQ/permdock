import { serve } from '@permdock/e2e-saas-kit/serve';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

serve({
  cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
  servers: [{ command: process.execPath, args: ['src/server.ts'], port: 3511 }],
});
