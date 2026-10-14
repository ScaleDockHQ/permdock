import type { ApprovalStore } from "../approvals/types.ts";
import type { Instant } from "../core/time.ts";

export type ApprovalWaitOptions = {
  /** When the approval request expires; the wait ends then whatever the store says. */
  readonly expiresAt?: Instant;
  /** Aborting rejects the wait with the signal's reason. */
  readonly signal?: AbortSignal;
};

/**
 * Suspends a run until an approval request is decided. `wait` resolves once
 * the request is no longer pending, `wake` is called for its token, or it
 * expires; it never says how the request was decided, so the caller always
 * decides again with the token. A durable runner implements it with its own
 * suspension primitive.
 */
export type ApprovalWaiter = {
  wait(token: string, options?: ApprovalWaitOptions): Promise<void>;
  /** Called after an approver resolves the request for `token`. */
  wake(token: string): void | Promise<void>;
};

export type PollingApprovalWaiterOptions = {
  readonly store: ApprovalStore;
  /** Milliseconds between reads of the store. Defaults to 5000. */
  readonly interval?: number;
};

const DEFAULT_INTERVAL = 5000;

/**
 * An in-process `ApprovalWaiter` that reads `store` every `interval`
 * milliseconds. `wake` ends a wait in the same process at once. A store read
 * that throws counts as still pending until the request expires.
 */
export function pollingApprovalWaiter(
  options: PollingApprovalWaiterOptions,
): ApprovalWaiter {
  const interval = options.interval ?? DEFAULT_INTERVAL;
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new RangeError(
      "PermDock: pollingApprovalWaiter interval must be a positive number",
    );
  }
  const woken = new Map<string, Set<() => void>>();

  const decided = async (token: string): Promise<boolean> => {
    try {
      const request = await options.store.get(token);
      return request?.status !== "pending";
    } catch {
      return false;
    }
  };

  return Object.freeze({
    wait(token: string, waitOptions: ApprovalWaitOptions = {}): Promise<void> {
      const { signal, expiresAt } = waitOptions;
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const listeners = woken.get(token) ?? new Set<() => void>();
        woken.set(token, listeners);
        const finish = (error?: Error): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          listeners.delete(done);
          if (listeners.size === 0) {
            woken.delete(token);
          }
          signal?.removeEventListener("abort", aborted);
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        };
        const done = (): void => {
          finish();
        };
        const aborted = (): void => {
          const reason: unknown = signal?.reason;
          finish(
            reason instanceof Error
              ? reason
              : new Error("PermDock: approval wait aborted", { cause: reason }),
          );
        };
        if (signal?.aborted === true) {
          aborted();
          return;
        }
        listeners.add(done);
        signal?.addEventListener("abort", aborted, { once: true });
        const poll = async (): Promise<void> => {
          if (!listeners.has(done)) {
            return;
          }
          const expired =
            expiresAt !== undefined &&
            expiresAt.epochMilliseconds <= Date.now();
          if (expired || (await decided(token))) {
            finish();
            return;
          }
          if (listeners.has(done)) {
            timer = setTimeout(() => {
              void poll();
            }, interval);
          }
        };
        void poll();
      });
    },
    wake(token: string): void {
      for (const listener of woken.get(token) ?? []) {
        listener();
      }
    },
  });
}
