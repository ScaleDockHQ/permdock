import { nowMillis } from "../core/time.ts";

/** A response the approvals handler replays for a repeated `Idempotency-Key`. */
export type IdempotentResponse = {
  /** Which request produced it: a reused key with another fingerprint is refused with `422`. */
  readonly fingerprint: string;
  readonly status: number;
  readonly headers: readonly (readonly [name: string, value: string])[];
  readonly body: string;
};

/**
 * Where `approvalsHandler` keeps `Idempotency-Key` responses
 * (draft-ietf-httpapi-idempotency-key-header). Keys arrive scoped to the
 * approver. Share one store across instances so a retry that lands on another
 * instance replays the first response.
 */
export type IdempotencyStore = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  get(
    key: string,
  ): IdempotentResponse | undefined | Promise<IdempotentResponse | undefined>;
  /** `expiresAt` is epoch milliseconds; the store may drop the entry after it. */
  set(
    key: string,
    response: IdempotentResponse,
    expiresAt: number,
  ): void | Promise<void>;
};

/** An in-process `IdempotencyStore`, for one instance and for tests. */
export function memoryIdempotencyStore(): IdempotencyStore {
  const entries = new Map<
    string,
    { readonly response: IdempotentResponse; readonly expiresAt: number }
  >();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) {
        return undefined;
      }
      if (entry.expiresAt <= nowMillis()) {
        entries.delete(key);
        return undefined;
      }
      return entry.response;
    },
    set(key, response, expiresAt) {
      entries.set(key, { response, expiresAt });
    },
  };
}
