import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createServer } from 'node:http';
import { sendResponse, toRequest } from 'permdock/node';

import { appRouter } from './app.ts';
import { memberUser } from './policy.ts';

const port = Number(process.env.PORT ?? 3461);

function isHealth(req: {
  readonly method?: string;
  readonly url?: string;
}): boolean {
  if (req.method !== 'GET') {
    return false;
  }
  const path = req.url ?? '';
  return path === '/health' || path.startsWith('/health?');
}

createServer((req, res) => {
  if (isHealth(req)) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const handle = async (): Promise<void> => {
    try {
      const response = await fetchRequestHandler({
        endpoint: '/trpc',
        req: toRequest(req),
        router: appRouter,
        createContext: () => ({ user: memberUser }),
      });
      await sendResponse(res, response);
    } catch {
      res.statusCode = 500;
      res.end();
    }
  };
  handle().catch(() => {
    res.statusCode = 500;
    res.end();
  });
}).listen(port, '127.0.0.1');
