import { serve } from '@hono/node-server';

import { permdockHandler } from './server.ts';

serve({
  fetch: (request): Response | Promise<Response> =>
    request.method === 'GET' && new URL(request.url).pathname === '/health'
      ? Response.json({ ok: true })
      : permdockHandler(request),
  port: Number(process.env['PORT'] ?? 3470),
  hostname: '127.0.0.1',
});
