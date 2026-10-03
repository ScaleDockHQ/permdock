import type { ProblemDetails } from "../core/errors.ts";
import type { Permission } from "../core/permissions.ts";
import type { Connection } from "./connection.ts";
import type { ProtectOptions } from "./create.ts";

import { PermDockRevokedError } from "../core/errors.ts";

export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  // SAFETY: value is a non-null object; the iterator member is only compared with typeof.
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

export type StreamProtectOptions = ProtectOptions & {
  /**
   * For a procedure that returns an async iterable: each outbound item is
   * checked against this permission and dropped when the subscriber cannot read it.
   */
  readonly items?: Permission<string, unknown, "instance">;
};

export type GuardIterableOptions = {
  /** Outbound items the subscriber cannot read under this permission are dropped. */
  readonly items?: Permission<string, unknown, "instance">;
  /** The row to check for an item (for example the data inside a tracked envelope). */
  readonly unwrap?: (item: unknown) => unknown;
  /** The framework error thrown to the subscriber when the connection aborts. */
  readonly onRevoked: (error: PermDockRevokedError) => unknown;
};

/**
 * Yields `source` until `connection.signal` aborts, dropping items the
 * subscriber can no longer read. The connection closes when iteration ends.
 */
export async function* guardIterable(
  source: AsyncIterable<unknown>,
  connection: Connection,
  options: GuardIterableOptions,
): AsyncGenerator<unknown, unknown, undefined> {
  const iterator: AsyncIterator<unknown, unknown> =
    source[Symbol.asyncIterator]();
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = (): void => {
      reject(
        connection.signal.reason instanceof PermDockRevokedError
          ? connection.signal.reason
          : new PermDockRevokedError({ code: "denied" }),
      );
    };
    if (connection.signal.aborted) {
      fail();
    } else {
      connection.signal.addEventListener("abort", fail, { once: true });
    }
  });
  aborted.catch(() => undefined);
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- items arrive one at a time
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done === true) {
        return next.value;
      }
      const row =
        options.unwrap === undefined ? next.value : options.unwrap(next.value);
      if (
        options.items === undefined ||
        connection.check(options.items, row).outcome === "granted"
      ) {
        yield next.value;
      }
    }
  } catch (error) {
    if (error instanceof PermDockRevokedError) {
      throw options.onRevoked(error);
    }
    throw error;
  } finally {
    connection.close();
    // A source parked on its next event would block `return` forever.
    const closing = iterator.return?.();
    if (closing !== undefined) {
      Promise.resolve(closing).catch(() => undefined);
    }
  }
}

/** WebSocket close code for a policy violation (RFC 6455 section 7.4.1). */
export const POLICY_VIOLATION = 1008;

/** The Problem Details for an aborted connection signal. */
function revokedProblem(signal: AbortSignal): ProblemDetails {
  const reason: unknown = signal.reason;
  return (
    reason instanceof PermDockRevokedError
      ? reason
      : new PermDockRevokedError({ code: "denied" })
  ).toProblemDetails();
}

/** Runs `end` once when the connection aborts, or now if it already has. */
export function onRevoked(
  connection: Connection,
  end: (problem: ProblemDetails) => void,
): void {
  const fire = (): void => {
    end(revokedProblem(connection.signal));
  };
  if (connection.signal.aborted) {
    fire();
  } else {
    connection.signal.addEventListener("abort", fire, { once: true });
  }
}
