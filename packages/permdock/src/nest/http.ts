import type { IncomingMessage } from "node:http";

import type { NodeRequest } from "../node/http.ts";

import {
  isServerResponse,
  sendResponse,
  toRequest as nodeToRequest,
} from "../node/http.ts";

export type { NodeRequest as NestHttpRequest } from "../node/http.ts";
export { sendResponse };

type FastifyReplyLike = {
  code(status: number): unknown;
  header(key: string, value: string): unknown;
  send(body: string): unknown;
};

function isReadable(value: unknown): value is IncomingMessage {
  // SAFETY: checked to be a non-null object first; read is only typeof-checked.
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly read?: unknown }).read === "function"
  );
}

function isFastifyReply(value: unknown): value is FastifyReplyLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // SAFETY: checked above to be a non-null object; each method is typeof-checked below.
  const reply = value as Record<string, unknown>;
  return (
    typeof reply["code"] === "function" &&
    typeof reply["header"] === "function" &&
    typeof reply["send"] === "function"
  );
}

/**
 * `@nestjs/platform-express` hands the guard an `IncomingMessage`;
 * `@nestjs/platform-fastify` hands it a `FastifyRequest` whose stream is `raw`.
 */
export function toRequest(req: NodeRequest): Request {
  if (isReadable(req)) {
    return nodeToRequest(req);
  }
  // SAFETY: an optional read of Fastify's raw stream; isReadable checks it below.
  const raw: unknown = (req as { readonly raw?: unknown }).raw;
  return nodeToRequest(req, isReadable(raw) ? raw : null);
}

export async function sendNestResponse(
  res: unknown,
  response: Response,
): Promise<void> {
  if (isServerResponse(res)) {
    await sendResponse(res, response);
    return;
  }
  if (isFastifyReply(res)) {
    res.code(response.status);
    for (const [key, value] of response.headers.entries()) {
      res.header(key, value);
    }
    await res.send(await response.text());
    return;
  }
  throw new TypeError(
    "permdock/nest supports @nestjs/platform-express and @nestjs/platform-fastify responses",
  );
}
