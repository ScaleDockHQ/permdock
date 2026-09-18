import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { app } from './app.ts';

const port = Number(process.env.PORT ?? 3477);
const host = '127.0.0.1';

type StreamRequestInit = RequestInit & { readonly duplex: 'half' };

function bufferChunk(chunk: unknown): Buffer {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return Buffer.alloc(0);
}

async function toRequest(req: IncomingMessage): Promise<Request> {
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
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(bufferChunk(chunk));
  }
  const body = Buffer.concat(chunks);
  if (body.byteLength === 0) {
    return new Request(url, { method, headers });
  }
  const init: StreamRequestInit = {
    method,
    headers,
    body,
    duplex: 'half',
  };
  return new Request(url, init);
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
      const response = await app.fetch(await toRequest(req));
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
