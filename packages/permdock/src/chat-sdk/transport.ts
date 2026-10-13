import type { CardElement } from "chat";

import type {
  ChatMessage,
  ChatTransport,
  DeliveryResult,
  DeliveryTarget,
  TransportOptions,
} from "../delivery/types.ts";

import { isDeliveryTarget } from "../delivery/target.ts";
import { approvalCard } from "./card.ts";

/** The part of a Chat SDK `Chat` the transport calls; a `new Chat(...)` fits. */
export type ChatSdkClient = {
  openDM(user: string): Promise<{
    post(message: string | CardElement): Promise<{ readonly id: string }>;
  }>;
};

export type ChatSdkTransportOptions = {
  /** The adapter name recipients are on (`slack`, `teams`, …); a target for another provider is rejected. */
  readonly provider: string;
  /** The workspace the bot is installed in; a target for another workspace is rejected. */
  readonly workspace?: string;
  /** Keys this transport remembers to skip a repeat post. Defaults to 1000. */
  readonly remember?: number;
};

const DEFAULT_REMEMBER = 1000;

function failed(
  cause: "rejected" | "invalid-recipient" | "rate-limited" | "unavailable",
  retryable: boolean,
  reason?: string,
): DeliveryResult {
  return reason === undefined
    ? { status: "failed", cause, retryable }
    : { status: "failed", cause, retryable, reason };
}

/** Maps a Chat SDK throw by its `ChatError` code; anything else is retryable. */
function chatSdkFailure(error: unknown): DeliveryResult {
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  switch (code) {
    case "RATE_LIMITED":
      return failed("rate-limited", true);
    case "NOT_IMPLEMENTED":
      return failed(
        "rejected",
        false,
        "the adapter cannot open a direct message",
      );
    default:
      return failed("unavailable", true);
  }
}

/**
 * The chat channel of `permdock/delivery` over the Chat SDK: opens a direct
 * message with the target's platform user id and posts the text, or the
 * approval card when the message carries an approval prompt. The Chat SDK
 * takes no idempotency key, so the transport skips a key it already sent,
 * per instance and in memory only.
 */
export function chatSdkTransport(
  chat: ChatSdkClient,
  options: ChatSdkTransportOptions,
): ChatTransport {
  const remember = options.remember ?? DEFAULT_REMEMBER;
  const sent = new Map<string, DeliveryResult>();

  const record = (key: string, result: DeliveryResult): void => {
    sent.set(key, result);
    if (sent.size > remember) {
      const oldest = sent.keys().next();
      if (oldest.done !== true) {
        sent.delete(oldest.value);
      }
    }
  };

  const deliver = async (
    target: DeliveryTarget<"chat">,
    message: ChatMessage,
    deliveryOptions: TransportOptions,
  ): Promise<DeliveryResult> => {
    if (!isDeliveryTarget(target, "chat")) {
      return failed("invalid-recipient", false);
    }
    if (
      (target.provider !== undefined && target.provider !== options.provider) ||
      (target.workspace !== undefined &&
        options.workspace !== undefined &&
        target.workspace !== options.workspace)
    ) {
      return failed(
        "rejected",
        false,
        "the target is on another platform or workspace",
      );
    }
    const previous = sent.get(deliveryOptions.idempotencyKey);
    if (previous !== undefined) {
      return previous;
    }
    let body: string | CardElement;
    try {
      body =
        message.approval === undefined
          ? message.text
          : approvalCard(message.approval.prompt, {
              approvalUrl: message.approval.url,
            });
    } catch {
      return { status: "failed", cause: "invalid-message", retryable: false };
    }
    try {
      const thread = await chat.openDM(target.address);
      const posted = await thread.post(body);
      const result: DeliveryResult = { status: "sent", providerId: posted.id };
      record(deliveryOptions.idempotencyKey, result);
      return result;
    } catch (error) {
      return chatSdkFailure(error);
    }
  };

  return Object.freeze({ channel: "chat" as const, name: "chat-sdk", deliver });
}
