import { Resend } from "resend";
import { describe, expect, it } from "vitest";

import type {
  DeliveryTarget,
  OutgoingEmail,
} from "../../src/delivery/index.ts";
import type {
  ResendClient,
  ResendEmailPayload,
} from "../../src/resend/index.ts";

import { memoryDecisionSink } from "../../src/core/sink.ts";
import { createPermDock } from "../../src/delivery/index.ts";
import { resendTransport } from "../../src/resend/index.ts";
import { testDeliveryTransport } from "../../src/testing/delivery-transport.ts";
import {
  deliveryPermissions as p,
  deliveryPolicy,
  deliveryPrincipals,
  invoice,
  sender,
} from "../fixtures/delivery.ts";

type Call = {
  readonly payload: ResendEmailPayload | readonly ResendEmailPayload[];
  readonly idempotencyKey: string | undefined;
};

type Failure =
  | { readonly name: string; readonly statusCode: number | null }
  | "throw";

function fakeResend() {
  const calls: Call[] = [];
  let next: Failure | undefined;
  let counter = 0;
  const nextId = (): string => {
    counter += 1;
    return `re_${String(counter)}`;
  };
  const respond = <T>(call: Call, data: () => T) => {
    const failure = next;
    next = undefined;
    if (failure === "throw") {
      return Promise.reject(new TypeError("fetch failed"));
    }
    if (failure !== undefined) {
      return Promise.resolve({
        data: null,
        error: { ...failure, message: failure.name },
      });
    }
    calls.push(call);
    return Promise.resolve({ data: data(), error: null });
  };
  const client: ResendClient = {
    emails: {
      send: (payload, options) =>
        respond({ payload, idempotencyKey: options?.idempotencyKey }, () => ({
          id: nextId(),
        })),
    },
    batch: {
      send: (payloads, options) =>
        respond(
          { payload: payloads, idempotencyKey: options?.idempotencyKey },
          () => ({ data: payloads.map(() => ({ id: nextId() })) }),
        ),
    },
  };
  return {
    client,
    calls,
    fail(value: Failure) {
      next = value;
    },
  };
}

const outgoing: OutgoingEmail = {
  from: "Acme Billing <billing@acme.test>",
  replyTo: "help@acme.test",
  subject: "Invoice i1",
  text: "Your invoice is ready.",
  html: "<p>Your invoice is ready.</p>",
  category: "notification",
  headers: {
    "Auto-Submitted": "auto-generated",
    "List-Unsubscribe": "<https://acme.test/u>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  },
};

async function target(): Promise<DeliveryTarget<"email">> {
  const permdock = await sender();
  const decision = permdock.decide(p.invoice.read, invoice, { trusted: true });
  if (decision.outcome !== "granted") {
    throw new Error("expected granted");
  }
  return {
    channel: "email",
    address: "ann@acme.test",
    principal: "u_2",
    decision,
  };
}

describe(resendTransport, () => {
  it("accepts a Resend client", () => {
    const client: ResendClient = new Resend("re_test_key");
    expect(resendTransport(client).channel).toBe("email");
  });

  it("maps the message, headers and tags and passes the idempotency key", async () => {
    const fake = fakeResend();
    const transport = resendTransport(fake.client, {
      tags: { app: "billing" },
    });
    const result = await transport.deliver(await target(), outgoing, {
      idempotencyKey: "pdd_abc",
      delivery: "dlv_1",
    });
    expect(result).toStrictEqual({ status: "sent", providerId: "re_1" });
    expect(fake.calls).toStrictEqual([
      {
        idempotencyKey: "pdd_abc",
        payload: {
          from: "Acme Billing <billing@acme.test>",
          to: ["ann@acme.test"],
          replyTo: "help@acme.test",
          subject: "Invoice i1",
          text: "Your invoice is ready.",
          html: "<p>Your invoice is ready.</p>",
          headers: outgoing.headers,
          tags: [
            { name: "app", value: "billing" },
            { name: "permdock_delivery", value: "dlv_1" },
            { name: "permdock_key", value: "pdd_abc" },
            { name: "permdock_category", value: "notification" },
          ],
        },
      },
    ]);
  });

  it("leaves out a delivery id outside the tag charset", async () => {
    const fake = fakeResend();
    await resendTransport(fake.client).deliver(await target(), outgoing, {
      idempotencyKey: "pdd_abc",
      delivery: "order 42/7",
    });
    const payload = fake.calls[0]?.payload;
    const tags =
      payload !== undefined && "to" in payload ? payload.tags : undefined;
    expect(tags?.map((tag) => tag.name)).toStrictEqual([
      "permdock_key",
      "permdock_category",
    ]);
  });

  it("throws for a tag outside the Resend charset", () => {
    expect(() =>
      resendTransport(fakeResend().client, { tags: { "bad tag": "x" } }),
    ).toThrow(TypeError);
    expect(() =>
      resendTransport(fakeResend().client, { tags: { permdock_key: "x" } }),
    ).toThrow(TypeError);
  });

  it("maps Resend error names to retryable and final failures", async () => {
    const cases = [
      ["rate_limit_exceeded", 429, "rate-limited", true],
      ["daily_quota_exceeded", 429, "quota-exceeded", true],
      ["monthly_quota_exceeded", 429, "quota-exceeded", true],
      ["concurrent_idempotent_requests", 409, "unavailable", true],
      ["internal_server_error", 500, "unavailable", true],
      ["application_error", 500, "unavailable", true],
      ["validation_error", 422, "rejected", false],
      ["invalid_from_address", 422, "invalid-message", false],
      ["invalid_api_key", 403, "unauthorized", false],
      ["missing_api_key", 401, "unauthorized", false],
      ["restricted_api_key", 401, "unauthorized", false],
      ["something_new", 400, "rejected", false],
      ["something_new", 503, "unavailable", true],
      ["something_new", null, "unavailable", true],
    ] as const;
    for (const [name, statusCode, cause, retryable] of cases) {
      const fake = fakeResend();
      fake.fail({ name, statusCode });
      expect(
        await resendTransport(fake.client).deliver(await target(), outgoing, {
          idempotencyKey: "pdd_abc",
          delivery: "dlv_1",
        }),
      ).toMatchObject({ status: "failed", cause, retryable, reason: name });
    }
  });

  it("maps a client throw to a retryable failure", async () => {
    const fake = fakeResend();
    fake.fail("throw");
    expect(
      await resendTransport(fake.client).deliver(await target(), outgoing, {
        idempotencyKey: "pdd_abc",
        delivery: "dlv_1",
      }),
    ).toMatchObject({
      status: "failed",
      cause: "unavailable",
      retryable: true,
    });
  });

  it("fans out through batch.send with one idempotency key per batch", async () => {
    const fake = fakeResend();
    const sink = memoryDecisionSink();
    const delivery = createPermDock(deliveryPolicy, {
      transports: {
        email: resendTransport(fake.client, { from: "billing@acme.test" }),
      },
      principals: deliveryPrincipals,
      sink,
    });
    const recipients = [
      { principal: "u_2", channel: "email", address: "ann@acme.test" },
      { principal: "u_1", channel: "email", address: "bob@acme.test" },
    ] as const;
    const message = {
      email: { subject: "Hi", text: "Hi", category: "transactional" },
    } as const;
    const permdock = await sender();
    const report = await delivery.deliver(
      permdock,
      p.invoice.read,
      invoice,
      recipients,
      message,
      { id: "dlv_batch" },
    );
    await delivery.deliver(
      permdock,
      p.invoice.read,
      invoice,
      recipients,
      message,
      { id: "dlv_batch" },
    );
    expect(report.events.map((event) => event.provider)).toStrictEqual([
      { name: "resend", id: "re_1" },
      { name: "resend", id: "re_2" },
    ]);
    expect(fake.calls).toHaveLength(2);
    const [first, second] = fake.calls;
    expect(Array.isArray(first?.payload)).toBe(true);
    expect(first?.idempotencyKey).toMatch(/^pdb_[A-Za-z0-9_-]{43}$/u);
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    // SAFETY: the batch call records its payload array, checked with Array.isArray above.
    const payloads = first?.payload as readonly ResendEmailPayload[];
    expect(payloads.map((entry) => entry.from)).toStrictEqual([
      "billing@acme.test",
      "billing@acme.test",
    ]);
  });
});

testDeliveryTransport("resendTransport", {
  channel: "email",
  address: "ann@acme.test",
  message: outgoing,
  create() {
    const fake = fakeResend();
    return {
      transport: resendTransport(fake.client),
      async received() {
        return fake.calls.map((call) => ({
          idempotencyKey: call.idempotencyKey ?? "",
        }));
      },
      fail(kind) {
        fake.fail(
          kind === "throw"
            ? "throw"
            : kind === "retryable"
              ? { name: "rate_limit_exceeded", statusCode: 429 }
              : { name: "validation_error", statusCode: 422 },
        );
      },
    };
  },
});
