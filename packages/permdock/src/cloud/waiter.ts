import type { ApprovalStore } from "../approvals/types.ts";
import type { ApprovalWaiter } from "../workflow/waiter.ts";
import type {
  PermDockCloudEvent,
  WebhookOptions,
  WebhookFailureCause,
} from "./webhook.ts";

import { statusProblem } from "../core/problem-types.ts";
import { CLOUD_EVENT_TYPES } from "../core/sink.ts";
import { problemResponse } from "../server/problem.ts";
import { pollingApprovalWaiter } from "../workflow/waiter.ts";
import { verifyWebhook } from "./webhook.ts";

/** Polling the store is the fallback for a webhook this process never receives. */
const FALLBACK_INTERVAL = 60_000;

export type CloudApprovalWaiterOptions = WebhookOptions &
  (
    | {
        /** Read when a wait starts and every `interval` after; typically `cloud().approvals`. */
        readonly store: ApprovalStore;
        /** Milliseconds between fallback reads of `store`. Defaults to 60000. */
        readonly interval?: number;
        readonly waiter?: undefined;
      }
    | {
        /** A durable runner's waiter (`workflowSdkWaiter()`); `wait` and `wake` go to it. */
        readonly waiter: ApprovalWaiter;
        readonly store?: undefined;
        readonly interval?: undefined;
      }
  );

export type CloudApprovalWaiter = ApprovalWaiter & {
  /**
   * The endpoint for the environment's webhook connector. It verifies the
   * Standard Webhooks signature and wakes the wait of every
   * `com.permdock.approval.resolved`, `.expired` and `.cancelled` event in
   * the batch. It answers `204` once handled or replayed, and Problem
   * Details otherwise.
   */
  readonly webhook: (request: Request) => Promise<Response>;
};

const WAKING: ReadonlySet<string> = new Set([
  CLOUD_EVENT_TYPES.approvalResolved,
  CLOUD_EVENT_TYPES.approvalExpired,
  CLOUD_EVENT_TYPES.approvalCancelled,
]);

/** The approval token of each event that ends a wait, in delivery order. */
export function approvalTokensOf(
  events: readonly PermDockCloudEvent[],
): readonly string[] {
  return events.flatMap((event) => {
    if (!WAKING.has(event.type)) {
      return [];
    }
    const { data } = event;
    return "token" in data &&
      typeof data.token === "string" &&
      data.token !== ""
      ? [data.token]
      : [];
  });
}

function refusal(cause: WebhookFailureCause): Response {
  switch (cause) {
    case "keys-unavailable":
      return problemResponse(
        statusProblem(503, "the webhook signing keys are unavailable"),
      );
    case "invalid-events":
      return problemResponse(
        statusProblem(400, "the body is not a PermDock CloudEvents batch"),
      );
    // Not 401: a webhook has no authentication scheme to name in the
    // WWW-Authenticate header RFC 9110 section 15.5.2 requires with it.
    case "missing-headers":
    case "malformed":
    case "timestamp-out-of-range":
      return problemResponse(
        statusProblem(400, `webhook verification failed: ${cause}`),
      );
    case "invalid-signature":
      return problemResponse(
        statusProblem(403, `webhook verification failed: ${cause}`),
      );
    case "replayed":
      return new Response(null, { status: 204 });
    default: {
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}

/**
 * An `ApprovalWaiter` that PermDock Cloud wakes. Mount `webhook` on the
 * route the environment's webhook connector posts to: when an approval is
 * resolved, expires or is cancelled, the parked run for its token wakes.
 * Waking never approves anything. The run decides again with the token, and
 * only the app's `decide` and its approval store can grant. Without
 * `waiter`, waits poll `store` as a fallback for a webhook another process
 * received.
 */
export function cloudApprovalWaiter(
  options: CloudApprovalWaiterOptions,
): CloudApprovalWaiter {
  const inner =
    options.waiter ??
    pollingApprovalWaiter({
      store: options.store,
      interval: options.interval ?? FALLBACK_INTERVAL,
    });
  const wake = async (token: string): Promise<void> => {
    try {
      await inner.wake(token);
    } catch {
      // A failed wake leaves the run parked until its next poll or expiry.
    }
  };
  return Object.freeze({
    wait: inner.wait.bind(inner),
    wake,
    async webhook(request: Request): Promise<Response> {
      const verified = await verifyWebhook(request, options);
      if (!verified.ok) {
        return refusal(verified.cause);
      }
      await Promise.all(approvalTokensOf(verified.events).map(wake));
      return new Response(null, { status: 204 });
    },
  });
}
