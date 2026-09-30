import type { IncomingMessage, ServerResponse } from 'node:http';

export type NodeRequest = IncomingMessage & {
  readonly originalUrl?: string;
  readonly protocol?: string;
  readonly body?: unknown;
};

type StreamRequestInit = RequestInit & { readonly duplex: 'half' };

export function toRequest(
  req: NodeRequest,
  stream: IncomingMessage | null = req,
): Request {
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
  if (stream === null) {
    return new Request(url, { method, headers });
  }
  const init: StreamRequestInit = {
    method,
    headers,
    body: incomingBody(stream),
    duplex: 'half',
  };
  return new Request(url, init);
}

function chunkOf(chunk: string | Buffer): Uint8Array {
  return typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk);
}

/**
 * Pull-based with `highWaterMark: 0`: nothing is read from `req` until the
 * Web body is consumed, so a later body parser (multer, `express.json()`)
 * still sees the whole stream.
 */
function incomingBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller): Promise<void> {
        return new Promise<void>((resolve) => {
          const drain = (): boolean => {
            // SAFETY: a paused IncomingMessage's read() yields a Buffer, a string with an encoding, or null.
            const chunk = req.read() as string | Buffer | null;
            if (chunk !== null) {
              controller.enqueue(chunkOf(chunk));
              return true;
            }
            if (req.readableEnded) {
              controller.close();
              return true;
            }
            return false;
          };
          if (drain()) {
            resolve();
            return;
          }
          const cleanup = (): void => {
            req.off('readable', onReadable);
            req.off('end', onEnd);
            req.off('error', onError);
          };
          const onReadable = (): void => {
            if (drain()) {
              cleanup();
              resolve();
            }
          };
          const onEnd = (): void => {
            cleanup();
            controller.close();
            resolve();
          };
          const onError = (err: Error): void => {
            cleanup();
            controller.error(err);
            resolve();
          };
          req.on('readable', onReadable);
          req.once('end', onEnd);
          req.once('error', onError);
        });
      },
    },
    { highWaterMark: 0 },
  );
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
    typeof value.setHeader === 'function' &&
    'end' in value
  );
}
