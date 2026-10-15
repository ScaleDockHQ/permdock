import type { IncomingMessage, ServerResponse } from "node:http";

import { fetchRequest, firstHeader, headersFrom } from "../server/kit.ts";

export type NodeRequest = IncomingMessage & {
  readonly originalUrl?: string;
  readonly protocol?: string;
  readonly body?: unknown;
};

export function toRequest(
  req: NodeRequest,
  stream: IncomingMessage | null = req,
): Request {
  const host = firstHeader(req.headers.host) ?? "localhost";
  const protocol = req.protocol ?? "http";
  const path = req.originalUrl ?? req.url ?? "/";
  const url = `${protocol}://${host}${path}`;
  return fetchRequest(
    url,
    req.method ?? "GET",
    headersFrom(req.headers),
    req.body,
    stream === null ? undefined : () => incomingBody(stream),
  );
}

function chunkOf(chunk: string | Buffer): Uint8Array {
  return typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
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
            req.off("readable", onReadable);
            req.off("end", onEnd);
            req.off("error", onError);
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
          req.on("readable", onReadable);
          req.once("end", onEnd);
          req.once("error", onError);
        });
      },
    },
    { highWaterMark: 0 },
  );
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
    typeof value === "object" &&
    value !== null &&
    "setHeader" in value &&
    typeof value.setHeader === "function" &&
    "end" in value
  );
}
