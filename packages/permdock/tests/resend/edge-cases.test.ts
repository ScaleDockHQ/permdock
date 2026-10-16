import { Resend } from "resend";
import { describe, expect, it } from "vitest";

import type {
  DeliveryTarget,
  OutgoingEmail,
  TransportItem,
} from "../../src/delivery/index.ts";
import type {
  ResendClient,
  ResendEmailPayload,
  ResendResult,
} from "../../src/resend/index.ts";
import type { ReplayStore } from "../../src/ssf/types.ts";

import { memoryDecisionSink } from "../../src/core/sink.ts";
import { resendTransport, resendWebhook } from "../../src/resend/index.ts";
import { webhookSigner } from "../../src/server/standard-webhooks.ts";
import { memoryReplayStore } from "../../src/ssf/replay.ts";
import {
  deliveryPermissions as p,
  invoice,
  sender,
} from "../fixtures/delivery.ts";

type BatchAnswer = ResendResult<{
  readonly data: readonly { readonly id: string }[];
}>;

const outgoing: OutgoingEmail = {
  from: "billing@acme.test",
  subject: "Invoice i1",
  text: "Your invoice is ready.",
  category: "transactional",
  headers: { "Auto-Submitted": "auto-generated" },
};

async function target(address: string): Promise<DeliveryTarget<"email">> {
  const permdock = await sender();
  const decision = permdock.decide(p.invoice.read, invoice, { trusted: true });
  if (decision.outcome !== "granted") {
    throw new Error("expected granted");
  }
  return { channel: "email", address, principal: "u_2", decision };
}

async function items(
  ...addresses: readonly string[]
): Promise<TransportItem<"email">[]> {
  return Promise.all(
    addresses.map(async (address, index) => ({
      target: await target(address),
      message: outgoing,
      options: { idempotencyKey: `pdd_${String(index)}`, delivery: "dlv_1" },
    })),
  );
}

function batchClient(answer: () => Promise<BatchAnswer>) {
  const sent: ResendEmailPayload[][] = [];
  const client: ResendClient = {
    emails: {
      send: () => Promise.reject(new Error("single send is not expected")),
    },
    batch: {
      send: (payloads) => {
        sent.push(payloads);
        return answer();
      },
    },
  };
  return { client, sent };
}

describe("resendTransport batch edge cases", () => {
  it("refuses every item without calling Resend when no target is valid", async () => {
    const { client, sent } = batchClient(() =>
      Promise.resolve({ data: { data: [] }, error: null }),
    );
    const results = await resendTransport(client).deliverBatch?.(
      await items("", ""),
    );
    expect(results).toEqual([
      { status: "failed", cause: "invalid-recipient", retryable: false },
      { status: "failed", cause: "invalid-recipient", retryable: false },
    ]);
    expect(sent).toEqual([]);
  });

  it("sends only the valid items and refuses the rest in place", async () => {
    const { client, sent } = batchClient(() =>
      Promise.resolve({ data: { data: [{ id: "re_9" }] }, error: null }),
    );
    const results = await resendTransport(client).deliverBatch?.(
      await items("", "ann@acme.test"),
    );
    expect(results).toEqual([
      { status: "failed", cause: "invalid-recipient", retryable: false },
      { status: "sent", providerId: "re_9" },
    ]);
    expect(sent.map((batch) => batch.map((entry) => entry.to))).toEqual([
      [["ann@acme.test"]],
    ]);
  });

  it("fails every valid item retryable when batch.send throws", async () => {
    const { client } = batchClient(() =>
      Promise.reject(new TypeError("fetch failed")),
    );
    const results = await resendTransport(client).deliverBatch?.(
      await items("ann@acme.test", "bob@acme.test"),
    );
    expect(results).toEqual([
      {
        status: "failed",
        cause: "unavailable",
        retryable: true,
        reason: "request failed",
      },
      {
        status: "failed",
        cause: "unavailable",
        retryable: true,
        reason: "request failed",
      },
    ]);
  });

  it("maps a batch error to the same failure for every valid item", async () => {
    const { client } = batchClient(() =>
      Promise.resolve({
        data: null,
        error: {
          name: "invalid_api_key",
          message: "API key is invalid",
          statusCode: 403,
        },
      }),
    );
    const results = await resendTransport(client).deliverBatch?.(
      await items("ann@acme.test", "", "bob@acme.test"),
    );
    expect(results).toEqual([
      {
        status: "failed",
        cause: "unauthorized",
        retryable: false,
        reason: "invalid_api_key",
      },
      { status: "failed", cause: "invalid-recipient", retryable: false },
      {
        status: "failed",
        cause: "unauthorized",
        retryable: false,
        reason: "invalid_api_key",
      },
    ]);
  });

  it("fails an item retryable when the batch answer has no id for it", async () => {
    const { client } = batchClient(() =>
      Promise.resolve({ data: { data: [{ id: "re_1" }] }, error: null }),
    );
    const results = await resendTransport(client).deliverBatch?.(
      await items("ann@acme.test", "bob@acme.test"),
    );
    expect(results).toEqual([
      { status: "sent", providerId: "re_1" },
      {
        status: "failed",
        cause: "unavailable",
        retryable: true,
        reason: "request failed",
      },
    ]);
  });
});

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const signer = webhookSigner({ keys: [{ alg: "v1", secret: SECRET }] });

const delivered = {
  type: "email.delivered",
  created_at: "2026-10-14T10:00:05.000Z",
  data: {
    email_id: "re_1",
    tags: { permdock_delivery: "dlv_1", permdock_key: "pdd_key" },
  },
};

async function signed(body: string, id: string): Promise<Request> {
  const headers = await signer.sign({ id, body });
  return new Request("https://acme.test/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": headers["webhook-id"],
      "svix-timestamp": headers["webhook-timestamp"],
      "svix-signature": headers["webhook-signature"],
      "content-type": "application/json",
    },
    body,
  });
}

describe("resendWebhook edge cases", () => {
  it("acknowledges a verified payload without data and writes nothing", async () => {
    const sink = memoryDecisionSink();
    const handler = resendWebhook({
      resend: new Resend("re_test_key"),
      secret: SECRET,
      sink,
      replay: memoryReplayStore(),
    });
    for (const [index, body] of [
      JSON.stringify({ type: "email.delivered" }),
      JSON.stringify({ type: "email.delivered", data: "re_1" }),
      JSON.stringify("email.delivered"),
    ].entries()) {
      const response = await handler(await signed(body, `msg_${index}`));
      expect(response.status).toBe(200);
    }
    expect(sink.events()).toEqual([]);
  });

  it("claims through seen and remember when the replay store has no claim", async () => {
    const remembered = new Map<string, number | undefined>();
    const replay: ReplayStore = {
      seen: (key) => remembered.has(key),
      remember: (key, expiresAt) => {
        remembered.set(key, expiresAt);
      },
    };
    const sink = memoryDecisionSink();
    const handler = resendWebhook({
      resend: new Resend("re_test_key"),
      secret: SECRET,
      sink,
      replay,
    });
    const body = JSON.stringify(delivered);
    expect((await handler(await signed(body, "msg_once"))).status).toBe(200);
    expect((await handler(await signed(body, "msg_once"))).status).toBe(200);
    expect(sink.events()).toHaveLength(1);
    expect([...remembered.keys()]).toEqual(["resend:msg_once"]);
    expect(remembered.get("resend:msg_once")).toBeGreaterThan(
      Date.now() / 1000,
    );
  });

  it("refuses a body over one million bytes with 413 before verifying", async () => {
    let verified = 0;
    const sink = memoryDecisionSink();
    const handler = resendWebhook({
      resend: {
        webhooks: {
          verify: () => {
            verified += 1;
            return delivered;
          },
        },
      },
      secret: SECRET,
      sink,
      replay: memoryReplayStore(),
    });
    const response = await handler(
      new Request("https://acme.test/webhooks/resend", {
        method: "POST",
        headers: {
          "webhook-id": "msg_big",
          "webhook-timestamp": "1760436000",
          "webhook-signature": "v1,AAAA",
        },
        body: "x".repeat(1_000_001),
      }),
    );
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(verified).toBe(0);
    expect(sink.events()).toEqual([]);
  });
});
