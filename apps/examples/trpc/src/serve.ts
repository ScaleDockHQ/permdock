import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createServer } from 'node:http';
import { sendResponse, toRequest } from 'permdock/node';

import { appRouter } from './app.ts';
import { memberUser } from './policy.ts';

const port = Number(process.env.PORT ?? 3461);

createServer((req, res) => {
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
