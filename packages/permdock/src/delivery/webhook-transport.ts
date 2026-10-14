import type { WebhookSigner } from "../server/standard-webhooks.ts";
import type {
  DeliveryResult,
  DeliveryTarget,
  TransportOptions,
  WebhookMessage,
  WebhookTransport,
} from "./types.ts";

import { CLOUDEVENTS_CONTENT_TYPE } from "../core/sink.ts";
import { isDeliveryTarget, isWebhookAddress } from "./target.ts";

export type WebhookTransportOptions = {
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Milliseconds before a request is aborted as `unavailable`. Defaults to 10000. */
  readonly timeout?: number;
};

function failed(
  cause: "rate-limited" | "unavailable" | "unauthorized" | "rejected",
  retryable: boolean,
  reason: string,
): DeliveryResult {
  return { status: "failed", cause, retryable, reason };
}

function fromStatus(status: number): DeliveryResult {
  if (status >= 200 && status < 300) {
    return { status: "sent" };
  }
  if (status === 429) {
    return failed("rate-limited", true, `HTTP ${status}`);
  }
  if (status === 408 || status >= 500) {
    return failed("unavailable", true, `HTTP ${status}`);
  }
  if (status === 401 || status === 403) {
    return failed("unauthorized", false, `HTTP ${status}`);
  }
  return failed("rejected", false, `HTTP ${status}`);
}

/**
 * Posts each CloudEvent to the target's https endpoint as
 * `application/cloudevents+json`, signed with the Standard Webhooks
 * headers. `webhook-id` is the idempotency key, so a retry repeats it and
 * the receiver drops the duplicate. Redirects are not followed.
 */
export function webhookTransport(
  signer: WebhookSigner,
  options: WebhookTransportOptions = {},
): WebhookTransport {
  const timeout = options.timeout ?? 10_000;
  return Object.freeze({
    channel: "webhook" as const,
    name: "webhook",
    async deliver(
      target: DeliveryTarget<"webhook">,
      message: WebhookMessage,
      transportOptions: TransportOptions,
    ): Promise<DeliveryResult> {
      if (
        !isDeliveryTarget(target, "webhook") ||
        !isWebhookAddress(target.address)
      ) {
        return {
          status: "failed",
          cause: "invalid-recipient",
          retryable: false,
        };
      }
      let body: string;
      try {
        body = JSON.stringify(message.event);
      } catch {
        return { status: "failed", cause: "invalid-message", retryable: false };
      }
      const headers = await signer.sign({
        id: transportOptions.idempotencyKey,
        body,
      });
      const send = options.fetch ?? globalThis.fetch;
      try {
        const response = await send(target.address, {
          method: "POST",
          headers: { ...headers, "content-type": CLOUDEVENTS_CONTENT_TYPE },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(timeout),
        });
        return fromStatus(response.status);
      } catch {
        return failed("unavailable", true, "request failed");
      }
    },
  });
}
