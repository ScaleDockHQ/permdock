import { serve } from '@hono/node-server';

import { app } from './app.ts';

serve({
  fetch: (request): Response | Promise<Response> => app.fetch(request),
  port: Number(process.env['PORT'] ?? 3471),
  hostname: '127.0.0.1',
});
