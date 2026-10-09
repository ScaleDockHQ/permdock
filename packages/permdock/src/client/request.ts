import { timeoutSignal } from "../core/timeout.ts";

/** Milliseconds a decision, refresh or approval request may take; a slower one is an error like a failed request. */
const STORE_TIMEOUT_MS = 10_000;

export type StoreHeaders = Readonly<Record<string, string>>;

/** A `GET` of `url`, or a JSON `POST` when there is a `body`. */
export type StoreRequest = (url: string, body?: unknown) => Promise<Response>;

export function storeRequest(
  fetchImpl: typeof fetch,
  headers: () => StoreHeaders | undefined,
): StoreRequest {
  return (url, body) =>
    fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      signal: timeoutSignal(STORE_TIMEOUT_MS),
      headers:
        body === undefined
          ? { accept: "application/json", ...headers() }
          : {
              accept: "application/json",
              "content-type": "application/json",
              ...headers(),
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
