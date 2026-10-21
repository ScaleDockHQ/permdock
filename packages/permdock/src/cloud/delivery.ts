import type { DeliveryChannel } from "../core/event-types.ts";
import type {
  DeliveryResult,
  DeliveryTarget,
  DeliveryTransport,
  TransportMessages,
  TransportOptions,
} from "../delivery/types.ts";
import type { CloudConnectionOptions } from "./types.ts";

import { compact, isRecord } from "../core/compact.ts";
import { isDeliveryTarget } from "../delivery/target.ts";
import { cloudConnection } from "./request.ts";

function failed(
  cause: Extract<DeliveryResult, { status: "failed" }>["cause"],
  retryable: boolean,
  reason: string,
): DeliveryResult {
  return { status: "failed", cause, retryable, reason };
}

async function fromResponse(response: Response): Promise<DeliveryResult> {
  const { status } = response;
  if (status >= 200 && status < 300) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const id = isRecord(body) ? body["id"] : undefined;
    return typeof id === "string" && id !== ""
      ? { status: "sent", providerId: id }
      : { status: "sent" };
  }
  const reason = `HTTP ${String(status)}`;
  if (status === 429) {
    return failed("rate-limited", true, reason);
  }
  if (status === 408 || status === 409 || status >= 500) {
    return failed("unavailable", true, reason);
  }
  if (status === 401 || status === 403) {
    return failed("unauthorized", false, reason);
  }
  if (status === 400 || status === 422) {
    return failed("invalid-message", false, reason);
  }
  return failed("rejected", false, reason);
}

/**
 * A `DeliveryTransport` for `channel` that hands each checked recipient to
 * PermDock Cloud, which sends it from its hosted email, chat or webhook sender
 * and reports back through `com.permdock.delivery.*` events. The router has
 * already decided the recipient: the Cloud receives the target and the
 * permission that let it through, never a decision to make. `Idempotency-Key`
 * is the delivery's idempotency key, so a retry repeats it.
 */
export function cloudDeliveryTransport<C extends DeliveryChannel>(
  channel: C,
  options: CloudConnectionOptions = {},
): DeliveryTransport<C> {
  const connection = cloudConnection(options);
  return Object.freeze({
    channel,
    name: "permdock-cloud",
    async deliver(
      target: DeliveryTarget<C>,
      message: TransportMessages[C],
      transportOptions: TransportOptions,
    ): Promise<DeliveryResult> {
      if (!isDeliveryTarget(target, channel)) {
        return {
          status: "failed",
          cause: "invalid-recipient",
          retryable: false,
        };
      }
      let body: string;
      try {
        body = JSON.stringify({
          channel,
          delivery: transportOptions.delivery,
          target: compact({
            address: target.address,
            principal: target.principal,
            provider: target.provider,
            workspace: target.workspace,
            trusted: target.trusted,
            permission: target.decision.matched.permission,
          }),
          message,
        });
      } catch {
        return { status: "failed", cause: "invalid-message", retryable: false };
      }
      try {
        const response = await connection.request("/deliveries", {
          method: "POST",
          headers: { "idempotency-key": transportOptions.idempotencyKey },
          body,
        });
        return await fromResponse(response);
      } catch {
        return failed("unavailable", true, "request failed");
      }
    },
  });
}
