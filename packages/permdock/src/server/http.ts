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
