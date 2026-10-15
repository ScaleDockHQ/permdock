import type { FastifyRequest } from "fastify";

import {
  fetchRequest,
  firstHeader,
  headersFrom,
  writeReply,
} from "../server/kit.ts";

export function toRequest(request: FastifyRequest): Request {
  const host = firstHeader(request.headers.host) ?? "localhost";
  return fetchRequest(
    `${request.protocol}://${host}${request.url}`,
    request.method,
    headersFrom(request.headers),
    request.body,
  );
}

export const sendReply: typeof writeReply = writeReply;
