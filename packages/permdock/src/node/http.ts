import type { IncomingMessage, ServerResponse } from 'node:http';

export type NodeRequest = IncomingMessage & {
  readonly originalUrl?: string;
  readonly protocol?: string;
  readonly body?: unknown;
};

type StreamRequestInit = RequestInit & { readonly duplex: 'half' };

export function toRequest(req: NodeRequest): Request {
  const host = headerValue(req.headers.host) ?? 'localhost';
  const protocol = req.protocol ?? 'http';
  const path = req.originalUrl ?? req.url ?? '/';
  const url = `${protocol}://${host}${path}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers.set(key, value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    }
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }
  const parsed = bodyOf(req, headers);
  if (parsed !== undefined) {
    return new Request(url, { method, headers, body: parsed });
  }
  const init: StreamRequestInit = {
    method,
    headers,
    body: incomingBody(req),
    duplex: 'half',
  };
  return new Request(url, init);
}

function incomingBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      req.on('data', (chunk: string | Buffer) => {
        controller.enqueue(
          typeof chunk === 'string'
            ? Buffer.from(chunk)
            : new Uint8Array(chunk),
        );
      });
      req.on('end', () => {
        controller.close();
      });
      req.on('error', (err: Error) => {
        controller.error(err);
      });
    },
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}

function bodyOf(req: NodeRequest, headers: Headers): string | undefined {
  if (req.body === undefined) {
    return undefined;
  }
  if (typeof req.body === 'string') {
    return req.body;
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return JSON.stringify(req.body);
}

export async function sendResponse(
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

export const fromResponse: typeof sendResponse = sendResponse;

export function isServerResponse(value: unknown): value is ServerResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'setHeader' in value &&
    typeof (value as ServerResponse).setHeader === 'function' &&
    'end' in value
  );
}
