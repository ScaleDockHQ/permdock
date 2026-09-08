import type { FastifyReply, FastifyRequest } from 'fastify';

export function toRequest(request: FastifyRequest): Request {
  const host = headerValue(request.headers.host) ?? 'localhost';
  const url = `${request.protocol}://${host}${request.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
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
  const method = request.method;
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }
  const body = bodyOf(request, headers);
  if (body === undefined) {
    return new Request(url, { method, headers });
  }
  return new Request(url, { method, headers, body });
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

function bodyOf(request: FastifyRequest, headers: Headers): string | undefined {
  if (request.body === undefined) {
    return undefined;
  }
  if (typeof request.body === 'string') {
    return request.body;
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return JSON.stringify(request.body);
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
