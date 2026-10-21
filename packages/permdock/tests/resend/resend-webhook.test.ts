import { Resend } from "resend";
import { describe, expect, it } from "vitest";

import type { DeliveryEvent } from "../../src/core/event-types.ts";

import { parseSinkEvents } from "../../src/core/parse-sink-events.ts";
import { memoryDecisionSink } from "../../src/core/sink.ts";
import { resendWebhook } from "../../src/resend/index.ts";
import { webhookSigner } from "../../src/server/standard-webhooks.ts";
import { memoryReplayStore } from "../../src/ssf/replay.ts";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const signer = webhookSigner({ keys: [{ alg: "v1", secret: SECRET }] });

function emailEvent(type: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    created_at: "2026-10-14T10:00:05.000Z",
    data: {
      created_at: "2026-10-14T10:00:00.000Z",
      email_id: "re_1",
      message_id: "<m1@resend>",
      from: "billing@acme.test",
      to: ["ann@acme.test"],
      subject: "Invoice",
      tags: {
        permdock_delivery: "dlv_1",
        permdock_key: "pdd_key",
        permdock_category: "notification",
      },
      ...extra,
    },
  };
}

async function signed(
  body: unknown,
  id = `msg_${globalThis.crypto.randomUUID()}`,
  prefix: "svix" | "webhook" = "svix",
): Promise<Request> {
  const text = JSON.stringify(body);
  const headers = await signer.sign({ id, body: text });
  return new Request("https://acme.test/webhooks/resend", {
    method: "POST",
    headers: {
      [`${prefix}-id`]: headers["webhook-id"],
      [`${prefix}-timestamp`]: headers["webhook-timestamp"],
      [`${prefix}-signature`]: headers["webhook-signature"],
      "content-type": "application/json",
    },
    body: text,
  });
}

function setup() {
  const sink = memoryDecisionSink();
  const handler = resendWebhook({
    resend: new Resend("re_test_key"),
    secret: SECRET,
    sink,
    replay: memoryReplayStore(),
    source: "https://acme.test",
  });
  return { sink, handler };
}

describe(resendWebhook, () => {
  it("maps delivery outcomes to delivery events", async () => {
    const cases = [
      [emailEvent("email.delivered"), { operation: "delivered" }],
      [
        emailEvent("email.bounced", {
          bounce: {
            message: "mailbox full",
            subType: "General",
            type: "Permanent",
          },
        }),
        { operation: "bounced", reason: "Permanent: mailbox full" },
      ],
      [emailEvent("email.complained"), { operation: "complained" }],
      [
        emailEvent("email.failed", { failed: { reason: "invalid domain" } }),
        {
          operation: "failed",
          cause: "rejected",
          retryable: false,
          reason: "invalid domain",
        },
      ],
      [
        emailEvent("email.suppressed", {
          suppressed: {
            message: "on the suppression list",
            type: "OnAccountSuppressionList",
          },
        }),
        { operation: "failed", cause: "suppressed", retryable: false },
      ],
    ] as const;
    for (const [body, expected] of cases) {
      const { sink, handler } = setup();
      const response = await handler(await signed(body));
      expect(response.status).toBe(200);
      const [event] = sink.events();
      expect(event).toMatchObject({
        type: "delivery",
        at: "2026-10-14T10:00:05.000Z",
        source: "https://acme.test",
        channel: "email",
        delivery: { id: "dlv_1", key: "pdd_key" },
        category: "notification",
        provider: { name: "resend", id: "re_1" },
        ...expected,
      });
      expect(parseSinkEvents([event])).toHaveLength(1);
      expect(JSON.stringify(event)).not.toContain("ann@acme.test");
    }
  });

  it("accepts the webhook-* header names too", async () => {
    const { sink, handler } = setup();
    const response = await handler(
      await signed(emailEvent("email.delivered"), undefined, "webhook"),
    );
    expect(response.status).toBe(200);
    expect(sink.events()).toHaveLength(1);
  });

  it("acknowledges opens, clicks and untagged mail without an event", async () => {
    const { sink, handler } = setup();
    const untagged = emailEvent("email.delivered");
    for (const body of [
      emailEvent("email.opened"),
      emailEvent("email.clicked", { click: { link: "https://x.test" } }),
      emailEvent("email.sent"),
      { ...untagged, data: { ...untagged.data, tags: {} } },
      {
        type: "contact.created",
        created_at: "2026-10-14T10:00:05.000Z",
        data: {},
      },
    ]) {
      expect((await handler(await signed(body))).status).toBe(200);
    }
    expect(sink.events()).toStrictEqual([]);
  });

  it("refuses a bad signature with 403 Problem Details and writes nothing", async () => {
    const { sink, handler } = setup();
    const request = await signed(emailEvent("email.delivered"));
    const tampered = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(emailEvent("email.bounced")),
    });
    const response = await handler(tampered);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    const unsigned = await handler(
      new Request("https://acme.test/webhooks/resend", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(unsigned.status).toBe(400);
    expect(sink.events()).toStrictEqual([]);
  });

  it("writes a replayed message id once", async () => {
    const { sink, handler } = setup();
    const body = emailEvent("email.delivered");
    expect((await handler(await signed(body, "msg_same"))).status).toBe(200);
    expect((await handler(await signed(body, "msg_same"))).status).toBe(200);
    expect(sink.events()).toHaveLength(1);
  });

  it("answers 405 to anything but POST", async () => {
    const { handler } = setup();
    const response = await handler(
      new Request("https://acme.test/webhooks/resend"),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("releases the message id when the sink fails, so Resend retries", async () => {
    let attempts = 0;
    const written: DeliveryEvent[] = [];
    const handler = resendWebhook({
      resend: new Resend("re_test_key"),
      secret: SECRET,
      sink: {
        write(events) {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("sink down");
          }
          for (const event of events) {
            if (event.type === "delivery") {
              written.push(event);
            }
          }
        },
      },
      replay: memoryReplayStore(),
    });
    const body = emailEvent("email.delivered");
    expect((await handler(await signed(body, "msg_retry"))).status).toBe(503);
    expect((await handler(await signed(body, "msg_retry"))).status).toBe(200);
    expect(written).toHaveLength(1);
  });
});
