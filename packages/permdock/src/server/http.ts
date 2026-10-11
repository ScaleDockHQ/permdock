/** Node-style headers (`IncomingHttpHeaders`, Fastify's) as Fetch `Headers`; repeated values stay separate. */
export function headersFrom(
  source: Readonly<Record<string, string | readonly string[] | undefined>>,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      headers.set(key, value);
      continue;
    }
    for (const item of value ?? []) {
      headers.append(key, item);
    }
  }
  return headers;
}

export function firstHeader(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }
  return value?.[0];
}

/**
 * A body a framework already parsed, as the text a Fetch `Request` carries.
 * A non-string body is serialised as JSON and, without a `content-type`,
 * labelled `application/json` on `headers`.
 */
export function parsedBody(
  body: unknown,
  headers: Headers,
): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return JSON.stringify(body);
}

type StreamRequestInit = RequestInit & { readonly duplex: "half" };

/**
 * A Fetch `Request` for a framework request. A `GET` or `HEAD` carries no
 * body; otherwise the body the framework parsed, or else `stream()`.
 */
export function fetchRequest(
  url: string,
  method: string,
  headers: Headers,
  body: unknown,
  stream?: () => ReadableStream<Uint8Array>,
): Request {
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const parsed = parsedBody(body, headers);
  if (parsed !== undefined) {
    return new Request(url, { method, headers, body: parsed });
  }
  if (stream === undefined) {
    return new Request(url, { method, headers });
  }
  const init: StreamRequestInit = {
    method,
    headers,
    body: stream(),
    duplex: "half",
  };
  return new Request(url, init);
}

/** A Fastify-style reply: `code`, `header` and `send`. */
export type ReplyLike = {
  code(status: number): unknown;
  header(key: string, value: string): unknown;
  send(body: string): unknown;
};

/** Writes `response` to a Fastify-style reply. */
export async function writeReply(
  reply: ReplyLike,
  response: Response,
): Promise<void> {
  reply.code(response.status);
  for (const [key, value] of response.headers.entries()) {
    reply.header(key, value);
  }
  await reply.send(await response.text());
}

/** The Fetch `Request` an RPC context carries as `request` or `req`. */
export function requestFromContext(context: object): Request | undefined {
  if ("request" in context && context.request instanceof Request) {
    return context.request;
  }
  if ("req" in context && context.req instanceof Request) {
    return context.req;
  }
  return undefined;
}

/** Whether the caller sent credentials, which turns a `401` into a `WWW-Authenticate` challenge. */
export function hasCredentials(
  request: Request | { readonly headers: { readonly authorization?: unknown } },
): boolean {
  return request instanceof Request
    ? request.headers.has("authorization")
    : request.headers.authorization !== undefined;
}

/** The Problem Details `detail` of `cause`, or `fallback` when it has none. */
export function problemMessage(cause: unknown, fallback: string): string {
  if (
    cause !== null &&
    typeof cause === "object" &&
    "detail" in cause &&
    typeof cause.detail === "string" &&
    cause.detail.length > 0
  ) {
    return cause.detail;
  }
  return fallback;
}
