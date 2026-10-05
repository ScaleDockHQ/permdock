import type { FastifyReply, FastifyRequest } from "fastify";

import { firstHeader, headersFrom, parsedBody } from "../server/http.ts";

export function toRequest(request: FastifyRequest): Request {
  const host = firstHeader(request.headers.host) ?? "localhost";
  const url = `${request.protocol}://${host}${request.url}`;
  const headers = headersFrom(request.headers);
  const method = request.method;
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const body = parsedBody(request.body, headers);
  if (body === undefined) {
    return new Request(url, { method, headers });
  }
  return new Request(url, { method, headers, body });
}

export async function sendReply(
  reply: FastifyReply,
  response: Response,
): Promise<void> {
  reply.code(response.status);
  for (const [key, value] of response.headers.entries()) {
    reply.header(key, value);
  }
  await reply.send(await response.text());
}
