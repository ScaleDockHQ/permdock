import { describe, expect, it } from "vitest";

import type { GrantedDecision } from "../core/decision.ts";
import type {
  DeliveryChannel,
  DeliveryResult,
  DeliveryTarget,
  DeliveryTransport,
  TransportMessages,
  TransportOptions,
} from "../delivery/index.ts";

import {
  allow,
  authenticated,
  definePermissions,
  definePolicy,
  getPermDock,
  resource,
} from "../index.ts";

/**
 * How a provider fails on its next call: a retryable error, a final error, or a
 * throw from its client.
 */
export type DeliveryFailureKind = "retryable" | "final" | "throw";

export type DeliveryTransportHarness<C extends DeliveryChannel> = {
  readonly transport: DeliveryTransport<C>;
  /**
   * What the provider accepted, one entry per delivery, with the idempotency
   * key it received.
   */
  received: () =>
    | readonly { readonly idempotencyKey: string }[]
    | Promise<readonly { readonly idempotencyKey: string }[]>;
  /** Makes the provider's next call fail this way. */
  fail: (kind: DeliveryFailureKind) => void;
};

export type DeliveryTransportOptions<C extends DeliveryChannel> = {
  readonly channel: C;
  /** An address the provider accepts on `channel`. */
  readonly address: string;
  readonly message: TransportMessages[C];
  /** A fresh harness per test. */
  create: () => DeliveryTransportHarness<C>;
};

const permissions = definePermissions({
  notice: resource({ actions: ["read"] }),
});

const policy = definePolicy(permissions, {
  grants: [allow(permissions.notice.read, { to: authenticated() })],
  subject: (user: { readonly id: string } | null) => user,
});

async function grantedDecision(): Promise<GrantedDecision> {
  const permdock = await getPermDock(policy, { id: "u_runner" });
  const decision = permdock.decide(
    permissions.notice.read,
    { id: "n_runner" },
    { trusted: true },
  );
  if (decision.outcome !== "granted") {
    throw new Error("testDeliveryTransport: the runner policy did not grant");
  }
  return decision;
}

function key(suffix: string): TransportOptions {
  return { idempotencyKey: `pdd_runner_${suffix}`, delivery: "dlv_runner" };
}

/**
 * Conformance for a `DeliveryTransport`: it sends a checked target with its
 * idempotency key, keeps the key on a retry, refuses a target without a granted
 * decision before calling the provider, and maps provider errors to retryable
 * or final failures without rejecting.
 */
export function testDeliveryTransport<C extends DeliveryChannel>(
  name: string,
  options: DeliveryTransportOptions<C>,
): void {
  const targetWith = async (decision: unknown): Promise<DeliveryTarget<C>> =>
    // SAFETY: a target as the router builds it; `decision` is forged in the refusal cases on purpose.
    ({
      channel: options.channel,
      address: options.address,
      principal: "u_runner",
      decision,
    }) as DeliveryTarget<C>;

  const send = async (
    harness: DeliveryTransportHarness<C>,
    target: DeliveryTarget<C>,
    suffix: string,
  ): Promise<DeliveryResult> =>
    harness.transport.deliver(target, options.message, key(suffix));

  describe(`${name} (delivery transport)`, () => {
    it("names its channel and provider", () => {
      const { transport } = options.create();
      expect(transport.channel).toBe(options.channel);
      expect(typeof transport.name).toBe("string");
      expect(transport.name).not.toBe("");
    });

    it("sends a checked target with its idempotency key", async () => {
      const harness = options.create();
      const result = await send(
        harness,
        await targetWith(await grantedDecision()),
        "a",
      );
      expect(result.status).toBe("sent");
      expect(await harness.received()).toEqual([
        { idempotencyKey: "pdd_runner_a" },
      ]);
    });

    it("passes the same key on a retry of the same delivery", async () => {
      const harness = options.create();
      const target = await targetWith(await grantedDecision());
      await send(harness, target, "b");
      await send(harness, target, "b");
      const received = await harness.received();
      expect(received.length).toBeGreaterThan(0);
      expect(
        received.every((entry) => entry.idempotencyKey === "pdd_runner_b"),
      ).toBe(true);
    });

    it("refuses a target without a granted decision and never calls the provider", async () => {
      const harness = options.create();
      for (const decision of [
        undefined,
        { outcome: "denied", denials: [], alternatives: [] },
        { outcome: "approval-required" },
      ]) {
        expect(
          await send(harness, await targetWith(decision), "c"),
        ).toMatchObject({
          status: "failed",
          cause: "invalid-recipient",
          retryable: false,
        });
      }
      expect(await harness.received()).toEqual([]);
    });

    it("maps a retryable provider error to a retryable failure", async () => {
      const harness = options.create();
      harness.fail("retryable");
      expect(
        await send(harness, await targetWith(await grantedDecision()), "d"),
      ).toMatchObject({ status: "failed", retryable: true });
    });

    it("maps a final provider error to a final failure", async () => {
      const harness = options.create();
      harness.fail("final");
      expect(
        await send(harness, await targetWith(await grantedDecision()), "e"),
      ).toMatchObject({ status: "failed", retryable: false });
    });

    it("resolves a provider throw as a retryable failure or rejects for the router to catch", async () => {
      const harness = options.create();
      harness.fail("throw");
      let result: DeliveryResult | undefined;
      try {
        result = await send(
          harness,
          await targetWith(await grantedDecision()),
          "f",
        );
      } catch {
        result = undefined;
      }
      if (result !== undefined) {
        expect(result).toMatchObject({ status: "failed", retryable: true });
      }
      expect(await harness.received()).toEqual([]);
    });
  });
}
