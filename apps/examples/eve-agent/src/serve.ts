import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { approval } from './agent.ts';
import { ownPost } from './permissions.ts';

const port = Number(process.env.PORT ?? 3474);
const host = '127.0.0.1';

function toRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? '/', `http://${host}:${String(port)}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    }
  }
  return new Request(url, {
    method: req.method,
    headers,
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function route(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === '/health') {
    return json({ ok: true });
  }
  if (request.method === 'GET' && path === '/list_posts') {
    const result = await approval.request(
      {},
      { toolName: 'list_posts', toolInput: {} },
    );
    return json({ result });
  }
  if (request.method === 'GET' && path === '/delete_post') {
    const result = await approval.request(
      {},
      { toolName: 'delete_post', toolInput: { id: ownPost.id } },
    );
    return json({ result });
  }
  return json({ error: 'not found' }, 404);
}

async function writeResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) {
    res.setHeader(key, value);
  }
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

createServer((req, res) => {
  const handle = async (): Promise<void> => {
    try {
      const response = await route(toRequest(req));
      await writeResponse(res, response);
    } catch {
      res.statusCode = 500;
      res.end();
    }
  };
  handle().catch(() => {
    res.statusCode = 500;
    res.end();
  });
}).listen(port, host);
