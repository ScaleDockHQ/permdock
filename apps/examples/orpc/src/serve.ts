import { RPCHandler } from '@orpc/server/fetch';
import { createServer } from 'node:http';
import { sendResponse, toRequest } from 'permdock/node';

import { router } from './app.ts';
import { memberUser } from './policy.ts';

const port = Number(process.env['PORT'] ?? 3462);
const handler = new RPCHandler(router);

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
      const request = toRequest(req);
      const result = await handler.handle(request, {
        prefix: '/rpc',
        context: { user: memberUser },
      });
      if (result.matched) {
        await sendResponse(res, result.response);
        return;
      }
      res.statusCode = 404;
      res.end();
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
