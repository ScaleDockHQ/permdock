import { describe, expect, it } from "vitest";

import type { ChatMessage, DeliveryTarget } from "../../src/delivery/index.ts";

import { cloudDeliveryTransport } from "../../src/cloud/delivery.ts";
import {
  deliveryPermissions as p,
  invoice,
  sender,
} from "../fixtures/delivery.ts";

const CLOUD_URL = "https://cloud.permdock.test";

async function chatTarget(): Promise<DeliveryTarget<"chat">> {
  const permdock = await sender();
  const decision = permdock.decide(p.invoice.read, invoice, { trusted: true });
  if (decision.outcome !== "granted") {
    throw new Error("expected granted");
  }
  return {
    channel: "chat",
    address: "U2",
    principal: "u_2",
    provider: "slack",
    decision,
  };
}

function cloud(respond: () => Response) {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return respond();
  };
  return {
    requests,
    transport: cloudDeliveryTransport("chat", {
      url: CLOUD_URL,
      key: "env-key",
      fetch: fetchImpl,
    }),
  };
}

const options = { idempotencyKey: "pdd_abc", delivery: "dlv_1" };

describe("cloudDeliveryTransport edge cases", () => {
  it("counts a 2xx answer without a JSON body as sent with no provider id", async () => {
    for (const body of ["accepted", null, '{"id":""}', "[]"]) {
      const { transport } = cloud(
        () => new Response(body, { status: body === null ? 204 : 202 }),
      );
      expect(
        await transport.deliver(await chatTarget(), { text: "hi" }, options),
      ).toEqual({ status: "sent" });
    }
  });

  it("fails invalid-message without a request when the message cannot be serialised", async () => {
    const { requests, transport } = cloud(() =>
      Response.json({ id: "cdl_1" }, { status: 202 }),
    );
    const message: ChatMessage = Object.assign(
      { text: "hi" },
      {
        toJSON(): never {
          throw new Error("not serialisable");
        },
      },
    );
    expect(
      await transport.deliver(await chatTarget(), message, options),
    ).toEqual({ status: "failed", cause: "invalid-message", retryable: false });
    expect(requests).toEqual([]);
  });
});
