import type {
  DeliveryChannel,
  DeliveryResult,
  DeliveryTarget,
  DeliveryTransport,
  TransportMessages,
  TransportOptions,
} from "./types.ts";

import { isDeliveryTarget } from "./target.ts";

export type MemoryDelivery<C extends DeliveryChannel> = {
  readonly target: DeliveryTarget<C>;
  readonly message: TransportMessages[C];
  readonly options: TransportOptions;
};

export type MemoryDeliveryTransport<C extends DeliveryChannel> =
  DeliveryTransport<C> & {
    /** Every delivery `respond` answered `sent` for, oldest first. */
    readonly deliveries: readonly MemoryDelivery<C>[];
  };

export type MemoryDeliveryTransportOptions<C extends DeliveryChannel> = {
  /** The result per delivery; defaults to `sent`. A throw propagates, as from a provider client. */
  readonly respond?: (
    target: DeliveryTarget<C>,
    message: TransportMessages[C],
  ) => DeliveryResult;
};

/** An in-process transport for tests and examples: it records what it would have sent. */
export function memoryDeliveryTransport<C extends DeliveryChannel>(
  channel: C,
  options: MemoryDeliveryTransportOptions<C> = {},
): MemoryDeliveryTransport<C> {
  const deliveries: MemoryDelivery<C>[] = [];
  return Object.freeze({
    channel,
    name: "memory",
    deliveries,
    deliver(
      target: DeliveryTarget<C>,
      message: TransportMessages[C],
      transportOptions: TransportOptions,
    ): DeliveryResult {
      if (!isDeliveryTarget(target, channel)) {
        return {
          status: "failed",
          cause: "invalid-recipient",
          retryable: false,
        };
      }
      const result = options.respond?.(target, message) ?? { status: "sent" };
      if (result.status === "sent") {
        deliveries.push(
          Object.freeze({ target, message, options: transportOptions }),
        );
      }
      return result;
    },
  });
}
