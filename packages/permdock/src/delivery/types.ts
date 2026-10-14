import type { GrantedDecision } from "../core/decision.ts";
import type {
  DeliveryChannel,
  DeliveryEvent,
  DeliveryFailureCause,
  EmailCategory,
} from "../core/event-types.ts";
import type { CloudEvent } from "../core/sink.ts";
import type { ApprovalPrompt } from "./approval-prompt.ts";

export type { DeliveryChannel, DeliveryFailureCause, EmailCategory };

/**
 * Who a delivery goes to. `{ principal }` names an app principal and the
 * address the server loaded for it on `channel`. `{ address }` alone is an
 * email or chat identity that resolves through
 * `PrincipalSource.principalByIdentity`; with no principal linked it is
 * refused unless `trusted` is set for an address the server loaded itself,
 * such as a customer's billing email, and then the sender must hold the
 * permission.
 */
export type Recipient =
  | {
      readonly principal: string;
      readonly channel: DeliveryChannel;
      /** An RFC 5322 `addr-spec`, a chat platform user id, or an https webhook endpoint. */
      readonly address: string;
      /** The chat platform (`slack`, `teams`, …). */
      readonly provider?: string;
      readonly workspace?: string;
    }
  | {
      readonly principal?: undefined;
      readonly channel: "email" | "chat";
      readonly address: string;
      /** The chat platform; required for a chat address. */
      readonly provider?: string;
      readonly workspace?: string;
      /** `true` only for an address the server loaded itself, never one from a request. */
      readonly trusted?: boolean;
    };

/** One-click unsubscribe (RFC 8058): an https URL, plus an optional `mailto:` address. */
export type EmailUnsubscribe = {
  readonly url: string;
  readonly mailto?: string;
};

export type EmailMessage = {
  /** Defaults to the router's `from`. A name-addr (`Acme <billing@acme.test>`) is allowed here. */
  readonly from?: string;
  readonly replyTo?: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /** Extra headers. `Auto-Submitted` and the `List-Unsubscribe` pair are the router's. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly category: EmailCategory;
  /** Required on `notification`, ignored on every other category. */
  readonly unsubscribe?:
    | EmailUnsubscribe
    | ((target: DeliveryTarget<"email">) => EmailUnsubscribe);
};

/** An email as a transport receives it: `from` set and the standards headers added. */
export type OutgoingEmail = Omit<
  EmailMessage,
  "from" | "unsubscribe" | "headers"
> & {
  readonly from: string;
  readonly headers: Readonly<Record<string, string>>;
};

export type ChatMessage = {
  readonly text: string;
  /** Rendered by the transport as its approval card, linking to `url`. */
  readonly approval?: {
    readonly prompt: ApprovalPrompt;
    readonly url: string;
  };
};

/** A CloudEvents 1.0 event, posted as `application/cloudevents+json`. */
export type WebhookMessage = {
  readonly event: CloudEvent;
};

export type DeliveryMessages = {
  readonly email: EmailMessage;
  readonly chat: ChatMessage;
  readonly webhook: WebhookMessage;
};

/** What a transport of channel `C` receives. */
export type TransportMessages = {
  readonly email: OutgoingEmail;
  readonly chat: ChatMessage;
  readonly webhook: WebhookMessage;
};

/**
 * A recipient the router checked: the granted decision that let it through
 * and the address in the form the channel compares. A transport refuses a
 * target without a granted `decision` (`isDeliveryTarget`).
 */
export type DeliveryTarget<C extends DeliveryChannel = DeliveryChannel> = {
  readonly channel: C;
  readonly address: string;
  /** Absent for a trusted address no principal is linked to. */
  readonly principal?: string;
  readonly provider?: string;
  readonly workspace?: string;
  readonly trusted?: true;
  readonly decision: GrantedDecision;
};

export type TransportOptions = {
  /** Stable for one delivery id and recipient: the provider's `Idempotency-Key` and the `webhook-id`. */
  readonly idempotencyKey: string;
  /** The delivery id every recipient of one `deliver` call shares. */
  readonly delivery: string;
};

export type DeliveryResult =
  | { readonly status: "sent"; readonly providerId?: string }
  | {
      readonly status: "failed";
      readonly cause: DeliveryFailureCause;
      /** Whether a retry with the same idempotency key may succeed. */
      readonly retryable: boolean;
      readonly reason?: string;
    };

/** One delivery as a transport receives it. */
export type TransportItem<C extends DeliveryChannel = DeliveryChannel> = {
  readonly target: DeliveryTarget<C>;
  readonly message: TransportMessages[C];
  readonly options: TransportOptions;
};

/**
 * One channel's sender. `deliver` resolves to a result; a throw or a
 * rejection counts as a retryable `unavailable` failure.
 */
export type DeliveryTransport<C extends DeliveryChannel = DeliveryChannel> = {
  readonly channel: C;
  /** The provider name delivery events carry (`resend`, `chat-sdk`, `webhook`). */
  readonly name: string;
  deliver(
    target: DeliveryTarget<C>,
    message: TransportMessages[C],
    options: TransportOptions,
  ): DeliveryResult | Promise<DeliveryResult>;
  /**
   * Sends several deliveries in one provider call, one result per item in
   * item order. The router uses it for two or more ready recipients.
   */
  deliverBatch?(
    items: readonly TransportItem<C>[],
  ): readonly DeliveryResult[] | Promise<readonly DeliveryResult[]>;
  /** The most items one `deliverBatch` call takes. Defaults to 100. */
  readonly batchSize?: number;
};

export type EmailTransport = DeliveryTransport<"email"> & {
  /** The `from` of an email whose message and router set none. */
  readonly from?: string;
};
export type ChatTransport = DeliveryTransport<"chat">;
export type WebhookTransport = DeliveryTransport<"webhook">;

export type DeliveryTransports = {
  readonly email?: EmailTransport;
  readonly chat?: ChatTransport;
  readonly webhook?: WebhookTransport;
};

export type DeliverOptions = {
  /** Keep it across retries so each recipient's idempotency key repeats. Defaults to `dlv_` and a random UUID. */
  readonly id?: string;
  /** The approval request id a prompt is delivered for, on every event. */
  readonly approval?: string;
};

export type DeliveryReport = {
  readonly id: string;
  /** One event per recipient, in recipient order. */
  readonly events: readonly DeliveryEvent[];
  readonly sent: number;
  readonly failed: number;
};
