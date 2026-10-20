import { sha256Digest } from "../core/sha256.ts";
import { nowMillis } from "../core/time.ts";

/** How long `approvalsHandler` keeps a response for a repeated `Idempotency-Key`. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** The approve or reject call a key was first used for. */
export type IdempotentCall = {
  readonly action: "approve" | "reject";
  /** The approval id in the path. */
  readonly id: string;
  /** The request body text as read; `""` without a body. */
  readonly body: string;
};

/** One `Idempotency-Key` entry as `approvalsHandler` stores it. */
export type IdempotencyRecord = {
  /** The store key: the approver's principal id and the field value, joined by a newline. */
  readonly key: string;
  readonly response: IdempotentResponse;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
};

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

/** The `IdempotencyStore` key for one approver's `Idempotency-Key`: keys never cross approvers. */
export function idempotencyRecordKey(principalId: string, key: string): string {
  return `${principalId}\n${key}`;
}

function fingerprintOf(call: IdempotentCall): string {
  return `${call.action} ${call.id} ${sha256Digest(call.body)}`;
}

/**
 * The record `approvalsHandler` stores after `call` answered `response`:
 * the status, headers and body text, the call's fingerprint, and an expiry
 * 24 hours after `now` (epoch milliseconds, default the clock).
 */
export async function idempotencyRecord(input: {
  readonly principalId: string;
  readonly key: string;
  readonly call: IdempotentCall;
  readonly response: Response;
  readonly now?: number;
}): Promise<IdempotencyRecord> {
  return {
    key: idempotencyRecordKey(input.principalId, input.key),
    response: {
      fingerprint: fingerprintOf(input.call),
      status: input.response.status,
      headers: [...input.response.headers.entries()],
      body: await input.response.clone().text(),
    },
    expiresAt: (input.now ?? nowMillis()) + IDEMPOTENCY_TTL_MS,
  };
}

/** Whether a stored response came from the same call: a reused key with another call is refused with `422`. */
export function matchesIdempotencyRecord(
  response: IdempotentResponse,
  call: IdempotentCall,
): boolean {
  return response.fingerprint === fingerprintOf(call);
}

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
