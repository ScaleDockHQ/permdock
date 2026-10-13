export { approvalPrompt, approvalUrlFor } from "./approval-prompt.ts";
export type { ApprovalPrompt, ApprovalUrl } from "./approval-prompt.ts";
export { audience, subscribersFor } from "./audience.ts";
export type { Audience, AudienceOptions, SubscriberEvent } from "./audience.ts";
export { memoryDeliveryTransport } from "./memory-transport.ts";
export type {
  MemoryDelivery,
  MemoryDeliveryTransport,
  MemoryDeliveryTransportOptions,
} from "./memory-transport.ts";
export { createPermDock } from "./router.ts";
export type { DeliveryPermDock, DeliveryPermDockOptions } from "./router.ts";
export { isAddrSpec, isDeliveryTarget } from "./target.ts";
export type {
  ChatMessage,
  ChatTransport,
  DeliverOptions,
  DeliveryChannel,
  DeliveryFailureCause,
  DeliveryMessages,
  DeliveryReport,
  DeliveryResult,
  DeliveryTarget,
  DeliveryTransport,
  DeliveryTransports,
  EmailCategory,
  EmailMessage,
  EmailTransport,
  EmailUnsubscribe,
  OutgoingEmail,
  Recipient,
  TransportItem,
  TransportMessages,
  TransportOptions,
  WebhookMessage,
  WebhookTransport,
} from "./types.ts";
export { webhookTransport } from "./webhook-transport.ts";
export type { WebhookTransportOptions } from "./webhook-transport.ts";
