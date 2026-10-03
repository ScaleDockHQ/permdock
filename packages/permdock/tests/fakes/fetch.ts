export type FetchCall = {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
};

export type FakeFetch = {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
};

/** A JSON response with `content-type: application/json`. */
export function json(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A `fetch` that records each request and answers through `reply`; a request
 * `reply` returns nothing for is answered 404. A thrown value becomes a
 * network failure.
 */
export function fakeFetch(
  reply: (
    call: FetchCall,
  ) => Response | undefined | Promise<Response | undefined>,
): FakeFetch {
  const calls: FetchCall[] = [];
  const fetcher = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const call = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body === null ? "" : await request.text(),
    };
    calls.push(call);
    return (await reply(call)) ?? new Response("not found", { status: 404 });
  };
  // SAFETY: fetcher has fetch's call signature; `preconnect` is never called by PermDock.
  return { fetch: fetcher as typeof fetch, calls };
}

/** Replies from a list in order, then repeats the last one. */
export function sequence(
  ...responses: readonly (() => Response)[]
): () => Response {
  let index = 0;
  return () => {
    const make = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (make === undefined) {
      throw new Error("sequence needs at least one response");
    }
    return make();
  };
}
