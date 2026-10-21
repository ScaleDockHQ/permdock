import { describe, expect, it } from "vitest";

import type {
  DeliveryTarget,
  OutgoingEmail,
} from "../../src/delivery/index.ts";
import type { DeliveryFailureKind } from "../../src/testing/delivery-transport.ts";

import { cloudDeliveryTransport } from "../../src/cloud/delivery.ts";
import { testDeliveryTransport } from "../../src/testing/delivery-transport.ts";
import {
  deliveryPermissions as p,
  invoice,
  sender,
} from "../fixtures/delivery.ts";

const CLOUD_URL = "https://cloud.permdock.test";
const KEY = "env-key";
const DELIVERIES = `${CLOUD_URL}/v1/environments/production/deliveries`;

type Posted = { readonly idempotencyKey: string; readonly body: unknown };

function fakeCloud(): {
  readonly fetch: typeof fetch;
  readonly posted: Posted[];
  respond: (status: number | "throw") => void;
} {
  const posted: Posted[] = [];
  let next: number | "throw" | undefined;
  let counter = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(DELIVERIES);
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    const failure = next;
    next = undefined;
    if (failure === "throw") {
      throw new TypeError("fetch failed");
    }
    if (failure !== undefined) {
      return new Response(null, { status: failure });
    }
    counter += 1;
    posted.push({
      idempotencyKey: request.headers.get("idempotency-key") ?? "",
      body: await request.json(),
    });
    return Response.json({ id: `cdl_${String(counter)}` }, { status: 202 });
  };
  return {
    fetch: fetchImpl,
    posted,
    respond(status) {
      next = status;
    },
  };
}

const outgoing: OutgoingEmail = {
  from: "Acme Billing <billing@acme.test>",
  subject: "Invoice i1",
  text: "Your invoice is ready.",
  category: "notification",
  headers: { "Auto-Submitted": "auto-generated" },
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

const options = (fake: ReturnType<typeof fakeCloud>) => ({
  url: CLOUD_URL,
  environment: "production",
  key: KEY,
  fetch: fake.fetch,
});

const FAILURES: Record<DeliveryFailureKind, number | "throw"> = {
  retryable: 503,
  final: 422,
  throw: "throw",
};

testDeliveryTransport("cloudDeliveryTransport", {
  channel: "email",
  address: "ann@acme.test",
  message: outgoing,
  create() {
    const fake = fakeCloud();
    return {
      transport: cloudDeliveryTransport("email", options(fake)),
      received: () =>
        fake.posted.map(({ idempotencyKey }) => ({ idempotencyKey })),
      fail: (kind) => {
        fake.respond(FAILURES[kind]);
      },
    };
  },
});

describe("cloudDeliveryTransport", () => {
  it("posts the checked recipient, the permission that let it through and the message", async () => {
    const fake = fakeCloud();
    const transport = cloudDeliveryTransport("email", options(fake));
    expect(transport).toMatchObject({
      channel: "email",
      name: "permdock-cloud",
    });
    const result = await transport.deliver(await target(), outgoing, {
      idempotencyKey: "pdd_abc",
      delivery: "dlv_1",
    });
    expect(result).toEqual({ status: "sent", providerId: "cdl_1" });
    expect(fake.posted).toEqual([
      {
        idempotencyKey: "pdd_abc",
        body: {
          channel: "email",
          delivery: "dlv_1",
          target: {
            address: "ann@acme.test",
            principal: "u_2",
            permission: p.invoice.read.key,
          },
          message: outgoing,
        },
      },
    ]);
  });

  it("maps Cloud statuses to retryable and final failures", async () => {
    const cases = [
      [429, "rate-limited", true],
      [408, "unavailable", true],
      [409, "unavailable", true],
      [500, "unavailable", true],
      [503, "unavailable", true],
      [401, "unauthorized", false],
      [403, "unauthorized", false],
      [400, "invalid-message", false],
      [422, "invalid-message", false],
      [404, "rejected", false],
    ] as const;
    for (const [status, cause, retryable] of cases) {
      const fake = fakeCloud();
      fake.respond(status);
      expect(
        await cloudDeliveryTransport("email", options(fake)).deliver(
          await target(),
          outgoing,
          { idempotencyKey: "pdd_abc", delivery: "dlv_1" },
        ),
      ).toEqual({
        status: "failed",
        cause,
        retryable,
        reason: `HTTP ${String(status)}`,
      });
    }
  });

  it("refuses a target for another channel without calling the Cloud", async () => {
    const fake = fakeCloud();
    const email = await target();
    const result = await cloudDeliveryTransport("chat", options(fake)).deliver(
      // SAFETY: an email target on the chat transport is the input under test.
      email as unknown as DeliveryTarget<"chat">,
      { text: "hello" },
      { idempotencyKey: "pdd_abc", delivery: "dlv_1" },
    );
    expect(result).toMatchObject({
      status: "failed",
      cause: "invalid-recipient",
    });
    expect(fake.posted).toEqual([]);
  });

  it("requires a key", () => {
    expect(() =>
      cloudDeliveryTransport("email", { url: CLOUD_URL, key: "" }),
    ).toThrow(/requires a key/u);
  });
});
