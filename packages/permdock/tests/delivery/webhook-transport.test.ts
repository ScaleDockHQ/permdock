import { describe, expect, it } from "vitest";

import type { CloudEvent } from "../../src/core/sink.ts";
import type { DeliveryTarget } from "../../src/delivery/index.ts";

import { deliveryEvent } from "../../src/core/delivery-event.ts";
import { toCloudEvent } from "../../src/core/sink.ts";
import { webhookTransport } from "../../src/delivery/index.ts";
import {
  webhookSigner,
  webhookVerifier,
} from "../../src/server/standard-webhooks.ts";
import { memoryReplayStore } from "../../src/ssf/replay.ts";
import {
  deliveryPermissions as p,
  invoice,
  sender,
} from "../fixtures/delivery.ts";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const signer = webhookSigner({ keys: [{ alg: "v1", secret: SECRET }] });

const event: CloudEvent = toCloudEvent(
  deliveryEvent({
    source: "https://acme.test",
    operation: "sent",
    channel: "email",
    delivery: { id: "dlv_1", key: "pdd_1" },
  }),
  { source: "https://acme.test", id: "evt_1" },
);

async function target(address: string): Promise<DeliveryTarget<"webhook">> {
  const permdock = await sender();
  const decision = permdock.decide(p.invoice.read, invoice, { trusted: true });
  if (decision.outcome !== "granted") {
    throw new Error("expected granted");
  }
  return {
    channel: "webhook",
    address,
    principal: "u_1",
    decision,
  };
}

function capture(status: number) {
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(null, { status });
  };
  return { requests, fetcher };
}

describe("webhookTransport", () => {
  it("posts a signed CloudEvent that webhookVerifier accepts", async () => {
    const { requests, fetcher } = capture(204);
    const transport = webhookTransport(signer, { fetch: fetcher });
    expect(transport.channel).toBe("webhook");
    const result = await transport.deliver(
      await target("https://hooks.customer.test/permdock"),
      { event },
      { idempotencyKey: "pdd_key", delivery: "dlv_1" },
    );
    expect(result).toEqual({ status: "sent" });
    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("content-type")).toBe(
      "application/cloudevents+json",
    );
    expect(request?.headers.get("webhook-id")).toBe("pdd_key");
    const verifier = webhookVerifier({
      secret: SECRET,
      replay: memoryReplayStore(),
    });
    const verified = await verifier.verify(request ?? new Request("https://x"));
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(JSON.parse(verified.body)).toEqual(event);
    }
  });

  it("maps the response status to a retryable or final failure", async () => {
    const cases = [
      [429, "rate-limited", true],
      [503, "unavailable", true],
      [408, "unavailable", true],
      [401, "unauthorized", false],
      [410, "rejected", false],
      [400, "rejected", false],
    ] as const;
    for (const [status, cause, retryable] of cases) {
      const { fetcher } = capture(status);
      const result = await webhookTransport(signer, { fetch: fetcher }).deliver(
        await target("https://hooks.customer.test/permdock"),
        { event },
        { idempotencyKey: "pdd_key", delivery: "dlv_1" },
      );
      expect(result).toMatchObject({ status: "failed", cause, retryable });
    }
  });

  it("treats a network error as retryable", async () => {
    const transport = webhookTransport(signer, {
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(
      await transport.deliver(
        await target("https://hooks.customer.test/permdock"),
        { event },
        { idempotencyKey: "pdd_key", delivery: "dlv_1" },
      ),
    ).toMatchObject({
      status: "failed",
      cause: "unavailable",
      retryable: true,
    });
  });

  it("refuses an endpoint that is not https and never fetches it", async () => {
    const { requests, fetcher } = capture(204);
    const transport = webhookTransport(signer, { fetch: fetcher });
    for (const address of [
      "http://hooks.test/h",
      "not a url",
      "file:///etc/passwd",
    ]) {
      expect(
        await transport.deliver(
          await target(address),
          { event },
          { idempotencyKey: "pdd_key", delivery: "dlv_1" },
        ),
      ).toEqual({
        status: "failed",
        cause: "invalid-recipient",
        retryable: false,
      });
    }
    expect(requests).toEqual([]);
  });
});
