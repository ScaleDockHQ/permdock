import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { app } from './app.ts';

const port = Number(process.env.PORT ?? 3468);
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
      const response = await Promise.resolve(app.fetch(toRequest(req)));
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
