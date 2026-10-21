import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { deliveryEvent } from "../../src/core/delivery-event.ts";
import {
  DELIVERY_EVENT_SCHEMA,
  EVENT_SCHEMA_IDS,
  SINK_EVENT_SCHEMAS,
} from "../../src/core/event-schemas.ts";
import {
  parseCloudEvent,
  parseSinkEvent,
} from "../../src/core/parse-sink-events.ts";
import {
  CLOUD_EVENT_TYPES,
  RESERVED_CLOUD_EVENT_TYPES,
  toCloudEvent,
} from "../../src/core/sink.ts";

const source = "https://app.example.com";

const sent = deliveryEvent({
  source: "permdock",
  operation: "sent",
  channel: "email",
  delivery: { id: "dlv_1", key: "pdd_abc" },
  recipient: { principal: { id: "u1" } },
  permission: "invoice.read",
  tenant: "o1",
  category: "notification",
  provider: { name: "resend", id: "em_1" },
  at: "2026-10-14T09:00:00Z",
});

describe(deliveryEvent, () => {
  it("builds a frozen-shape delivery event with an RFC 3339 time", () => {
    expect(sent).toStrictEqual({
      type: "delivery",
      at: "2026-10-14T09:00:00Z",
      source: "permdock",
      operation: "sent",
      channel: "email",
      delivery: { id: "dlv_1", key: "pdd_abc" },
      recipient: { principal: { id: "u1" } },
      permission: "invoice.read",
      tenant: "o1",
      category: "notification",
      provider: { name: "resend", id: "em_1" },
    });
    const now = deliveryEvent({
      source: "permdock",
      operation: "delivered",
      channel: "chat",
      delivery: { id: "dlv_1", key: "pdd_abc" },
    });
    expect(now.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("keeps cause and retryable for failed events only", () => {
    expect(() =>
      deliveryEvent({
        source: "permdock",
        operation: "sent",
        channel: "email",
        delivery: { id: "dlv_1", key: "pdd_abc" },
        cause: "rate-limited",
      }),
    ).toThrow(TypeError);
    const failed = deliveryEvent({
      source: "permdock",
      operation: "failed",
      channel: "webhook",
      delivery: { id: "dlv_1", key: "pdd_abc" },
      cause: "denied",
      retryable: false,
      reason: "no-grant",
    });
    expect(failed).toMatchObject({
      cause: "denied",
      retryable: false,
      reason: "no-grant",
    });
  });

  it("refuses a malformed time", () => {
    expect(() =>
      deliveryEvent({
        source: "permdock",
        operation: "sent",
        channel: "email",
        delivery: { id: "dlv_1", key: "pdd_abc" },
        at: "yesterday",
      }),
    ).toThrow(RangeError);
  });
});

describe("the delivery event family", () => {
  it("publishes its schema under its $id", () => {
    expect(SINK_EVENT_SCHEMAS.delivery).toBe(DELIVERY_EVENT_SCHEMA);
    expect(DELIVERY_EVENT_SCHEMA.$id).toBe(EVENT_SCHEMA_IDS.delivery);
    expect(
      JSON.parse(
        readFileSync(
          new URL("../../schemas/delivery-event-v1.json", import.meta.url),
          "utf8",
        ),
      ),
    ).toStrictEqual(DELIVERY_EVENT_SCHEMA);
  });

  it("agrees with Ajv and parseSinkEvent", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addFormat("date-time", true);
    const validate = ajv.compile(DELIVERY_EVENT_SCHEMA);
    const json: unknown = JSON.parse(JSON.stringify(sent));
    expect(validate(json) ? [] : validate.errors).toStrictEqual([]);
    expect(parseSinkEvent(json)).toStrictEqual(sent);
  });

  it("drops events that break the schema or the failed-only rule", () => {
    for (const bad of [
      { ...sent, channel: "sms" },
      { ...sent, operation: "opened" },
      { ...sent, delivery: { id: "dlv_1" } },
      { ...sent, at: "2026-10-14" },
      { ...sent, cause: "rate-limited" },
      { ...sent, retryable: true },
      { ...sent, recipient: { address: "a@example.com" } },
    ]) {
      expect(parseSinkEvent(bad)).toBeNull();
    }
  });

  it("maps each operation onto its com.permdock.delivery type and round-trips", () => {
    const types = [
      ["sent", CLOUD_EVENT_TYPES.deliverySent],
      ["delivered", CLOUD_EVENT_TYPES.deliveryDelivered],
      ["bounced", CLOUD_EVENT_TYPES.deliveryBounced],
      ["complained", CLOUD_EVENT_TYPES.deliveryComplained],
      ["failed", CLOUD_EVENT_TYPES.deliveryFailed],
    ] as const;
    for (const [operation, type] of types) {
      const event = { ...sent, operation };
      const cloud = toCloudEvent(event, { source, id: `e_${operation}` });
      expect(cloud).toMatchObject({
        type,
        subject: "dlv_1",
        dataschema: EVENT_SCHEMA_IDS.delivery,
      });
      expect(parseCloudEvent(JSON.parse(JSON.stringify(cloud)))).toStrictEqual(
        cloud,
      );
    }
  });

  it("is no longer reserved", () => {
    for (const type of RESERVED_CLOUD_EVENT_TYPES) {
      expect(type.startsWith("com.permdock.delivery.")).toBe(false);
    }
  });
});
