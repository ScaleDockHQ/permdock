import type { DeliveryResult } from "../../src/delivery/index.ts";

import {
  memoryDeliveryTransport,
  webhookTransport,
} from "../../src/delivery/index.ts";
import { webhookSigner } from "../../src/server/standard-webhooks.ts";
import { testDeliveryTransport } from "../../src/testing/delivery-transport.ts";

testDeliveryTransport("memoryDeliveryTransport", {
  channel: "email",
  address: "ann@acme.test",
  message: {
    from: "billing@acme.test",
    subject: "Hello",
    text: "Hello",
    category: "transactional",
    headers: { "Auto-Submitted": "auto-generated" },
  },
  create() {
    let next: "retryable" | "final" | "throw" | undefined;
    const transport = memoryDeliveryTransport("email", {
      respond(): DeliveryResult {
        const kind = next;
        next = undefined;
        switch (kind) {
          case undefined:
            return { status: "sent" };
          case "retryable":
            return { status: "failed", cause: "unavailable", retryable: true };
          case "final":
            return { status: "failed", cause: "rejected", retryable: false };
          case "throw":
            throw new Error("provider down");
          default: {
            const never: never = kind;
            return never;
          }
        }
      },
    });
    return {
      transport,
      received: () =>
        transport.deliveries.map((entry) => ({
          idempotencyKey: entry.options.idempotencyKey,
        })),
      fail(kind) {
        next = kind;
      },
    };
  },
});

testDeliveryTransport("webhookTransport", {
  channel: "webhook",
  address: "https://hooks.customer.test/permdock",
  message: {
    event: {
      specversion: "1.0",
      type: "com.permdock.delivery.sent",
      source: "https://acme.test",
      id: "evt_1",
      time: "2026-10-14T10:00:00.000Z",
      datacontenttype: "application/json",
      dataschema: "https://permdock.com/schemas/delivery-event-v1.json",
      data: {
        type: "delivery",
        at: "2026-10-14T10:00:00.000Z",
        source: "https://acme.test",
        operation: "sent",
        channel: "email",
        delivery: { id: "dlv_1", key: "pdd_1" },
      },
    },
  },
  create() {
    const received: { idempotencyKey: string }[] = [];
    let next: "retryable" | "final" | "throw" | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      const kind = next;
      next = undefined;
      if (kind === "throw") {
        throw new TypeError("fetch failed");
      }
      if (kind === undefined) {
        received.push({
          idempotencyKey:
            new Request(input, init).headers.get("webhook-id") ?? "",
        });
      }
      return new Response(null, {
        status: kind === "retryable" ? 503 : kind === "final" ? 400 : 200,
      });
    };
    return {
      transport: webhookTransport(
        webhookSigner({
          keys: [
            { alg: "v1", secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" },
          ],
        }),
        { fetch: fetcher },
      ),
      received: () => received,
      fail(kind) {
        next = kind;
      },
    };
  },
});
