import type { DeliveryEvent } from "./event-types.ts";

import { compact } from "./compact.ts";
import { requireEventInstant } from "./event-time.ts";

/**
 * A `delivery` sink event. Throws a `TypeError` when `cause` or `retryable`
 * is set on an operation other than `failed`, and a `RangeError` for a
 * malformed `at`.
 */
export function deliveryEvent(
  input: Omit<DeliveryEvent, "type" | "at"> & {
    /** An RFC 3339 instant; defaults to now. */
    readonly at?: string;
  },
): DeliveryEvent {
  if (
    input.operation !== "failed" &&
    (input.cause !== undefined || input.retryable !== undefined)
  ) {
    throw new TypeError(
      "PermDock: cause and retryable belong on failed delivery events only",
    );
  }
  return compact<DeliveryEvent>({
    type: "delivery",
    at: requireEventInstant(input.at, "at") ?? new Date().toISOString(),
    source: input.source,
    operation: input.operation,
    channel: input.channel,
    delivery: { id: input.delivery.id, key: input.delivery.key },
    recipient: input.recipient,
    permission: input.permission,
    tenant: input.tenant,
    category: input.category,
    approval: input.approval,
    provider: input.provider,
    cause: input.cause,
    retryable: input.retryable,
    reason: input.reason,
  });
}
