import { describe, expect, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";
import type { CloudEvent } from "../../src/core/sink.ts";
import type { Principal } from "../../src/core/subject.ts";
import type {
  DeliveryResult,
  DeliveryTarget,
  EmailMessage,
  Recipient,
} from "../../src/delivery/index.ts";

import { deliveryEvent } from "../../src/core/delivery-event.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { memoryMembershipSource } from "../../src/core/memory-sources.ts";
import { getPermDockSync as createCorePermDock } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { toCloudEvent } from "../../src/core/sink.ts";
import {
  approvalPrompt,
  approvalUrlFor,
  audience,
  createPermDock,
  memoryDeliveryTransport,
  webhookTransport,
} from "../../src/delivery/index.ts";
import { webhookSigner } from "../../src/server/standard-webhooks.ts";
import {
  deliveryPermissions as p,
  deliveryPolicy,
  deliveryPrincipals,
  invoice,
  sender,
} from "../fixtures/delivery.ts";

const email: EmailMessage = {
  subject: "Invoice i1",
  text: "Your invoice is ready.",
  category: "transactional",
};

const ann = {
  principal: "u_2",
  channel: "email",
  address: "ann@acme.test",
} as const;

function setup() {
  const mail = memoryDeliveryTransport("email");
  const delivery = createPermDock(deliveryPolicy, {
    transports: { email: mail },
    principals: deliveryPrincipals,
    from: "billing@acme.test",
  });
  return { mail, delivery };
}

function throwing<V extends PermDock>(
  permdock: V,
  member: "decideFor" | "whoCan",
): V {
  return {
    ...permdock,
    [member]: () => Promise.reject(new Error("source down")),
  };
}

describe("createPermDock (delivery) edge cases", () => {
  it("refuses a malformed recipient as invalid-recipient", async () => {
    const { mail, delivery } = setup();
    const malformed: unknown[] = [
      null,
      "ann@acme.test",
      { principal: "u_2", channel: "fax", address: "ann@acme.test" },
      { principal: "u_2", channel: "email", address: 42 },
      { principal: "", channel: "email", address: "ann@acme.test" },
      { principal: "u_2", channel: "chat", address: "U2", provider: "" },
      { principal: "u_2", channel: "chat", address: "U2", workspace: 7 },
    ];
    const report = await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      // SAFETY: malformed recipients, as untyped caller data could pass them.
      malformed as readonly Recipient[],
      { email, chat: { text: "hi" } },
    );
    expect(report.sent).toBe(0);
    expect(mail.deliveries).toEqual([]);
    expect(report.events.map((event) => event.cause)).toEqual(
      malformed.map(() => "invalid-recipient"),
    );
    expect(report.events.map((event) => event.channel)).toEqual([
      "email",
      "email",
      "email",
      "email",
      "email",
      "chat",
      "chat",
    ]);
  });

  it("denies with the approval-required reason when the grant needs an approval", async () => {
    const policy = definePolicy(p, {
      scopes: { tenant: { key: "orgId" } },
      roles: [
        role("member", [allow(p.invoice.read, { approval: "human" })], {
          on: "tenant",
        }),
      ],
      subject: (user: Principal | null) => user,
    });
    const permdock = createCorePermDock(
      policy,
      { id: "u_1", kind: "user", tenant: "o1" },
      {
        memberships: memoryMembershipSource({
          u_1: [{ scope: "tenant", id: "o1", roles: ["member"] }],
          u_2: [{ scope: "tenant", id: "o1", roles: ["member"] }],
        }),
        principals: deliveryPrincipals,
      },
    );
    const mail = memoryDeliveryTransport("email");
    const report = await createPermDock(policy, {
      transports: { email: mail },
      principals: deliveryPrincipals,
      from: "billing@acme.test",
    }).deliver(permdock, p.invoice.read, invoice, [ann], { email });
    expect(mail.deliveries).toEqual([]);
    expect(report.events[0]).toMatchObject({
      operation: "failed",
      cause: "denied",
      retryable: false,
      reason: "approval-required",
    });
  });

  it("fails retryable when a transport resolves to no result", async () => {
    const delivery = createPermDock(deliveryPolicy, {
      transports: {
        email: {
          channel: "email",
          name: "silent",
          // SAFETY: a transport that breaks its contract, the case under test.
          deliver: () => undefined as unknown as DeliveryResult,
        },
      },
      principals: deliveryPrincipals,
      from: "billing@acme.test",
    });
    const report = await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      [ann],
      { email },
    );
    expect(report.events[0]).toMatchObject({
      operation: "failed",
      cause: "unavailable",
      retryable: true,
      reason: "transport returned no result",
      provider: { name: "silent" },
    });
  });

  it("denies a recipient as closure-error when decideFor throws", async () => {
    const { mail, delivery } = setup();
    const report = await delivery.deliver(
      throwing(await sender(), "decideFor"),
      p.invoice.read,
      invoice,
      [ann],
      { email },
    );
    expect(mail.deliveries).toEqual([]);
    expect(report.events[0]).toMatchObject({
      operation: "failed",
      cause: "denied",
      retryable: false,
      reason: "closure-error",
    });
  });

  it("fails invalid-message when the unsubscribe function throws", async () => {
    const { mail, delivery } = setup();
    const report = await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      [ann],
      {
        email: {
          ...email,
          category: "notification",
          unsubscribe: () => {
            throw new Error("token store down");
          },
        },
      },
    );
    expect(mail.deliveries).toEqual([]);
    expect(report.events[0]).toMatchObject({
      cause: "invalid-message",
      retryable: false,
      reason: "unsubscribe threw",
    });
  });

  it("refuses an unsubscribe mailto, replyTo, text or envelope header the message cannot carry", async () => {
    const cases: readonly [EmailMessage, string][] = [
      [
        {
          ...email,
          category: "notification",
          unsubscribe: {
            url: "https://acme.test/u",
            mailto: "Unsubscribe <u@acme.test>",
          },
        },
        "unsubscribe mailto is not an addr-spec",
      ],
      [{ ...email, replyTo: "help desk" }, "replyTo is not an addr-spec"],
      [{ ...email, text: "" }, "text is empty"],
      [
        { ...email, headers: { Bcc: "audit@evil.test" } },
        "header Bcc is set through the message, not headers",
      ],
    ];
    for (const [message, reason] of cases) {
      const { mail, delivery } = setup();
      const report = await delivery.deliver(
        await sender(),
        p.invoice.read,
        invoice,
        [ann],
        { email: message },
      );
      expect(mail.deliveries).toEqual([]);
      expect(report.events[0]).toMatchObject({
        cause: "invalid-message",
        reason,
      });
    }
  });
});

describe("audience edge cases", () => {
  const reports = definePermissions({
    report: resource({ collection: ["export"] }),
  });

  it("counts a decideFor throw as denied", async () => {
    const found = await audience(
      throwing(await sender(), "decideFor"),
      p.invoice.read,
      invoice,
      { candidates: ["u_1", "u_2"] },
    );
    expect(found).toEqual({ principals: [], complete: true });
  });

  it("is empty and incomplete for a collection permission without candidates", async () => {
    const found = await audience(
      await sender(),
      reports.report.export,
      undefined,
    );
    expect(found).toEqual({ principals: [], complete: false });
  });

  it("is empty and complete for an anonymous sender without candidates", async () => {
    const anonymous = createCorePermDock(deliveryPolicy, null, {
      principals: deliveryPrincipals,
    });
    expect(await audience(anonymous, p.invoice.read, invoice)).toEqual({
      principals: [],
      complete: true,
    });
  });

  it("is empty and incomplete when whoCan throws", async () => {
    const found = await audience(
      throwing(await sender(), "whoCan"),
      p.invoice.read,
      invoice,
    );
    expect(found).toEqual({ principals: [], complete: false });
  });
});

describe("approvalUrlFor edge cases", () => {
  const prompt = approvalPrompt({
    v: 1,
    id: "apr_1",
    token: "secret-token",
    permission: "invoice.pay",
    scope: "tenant",
    resource: { type: "invoice", id: "i1" },
    subject: { principal: null },
    detail: "Pay invoice i1",
    createdAt: "2026-10-14T10:00:00.000Z",
    expiresAt: "2026-10-15T10:00:00.000Z",
    status: "pending",
  });

  it("throws a TypeError for a value that is not a URL", () => {
    expect(() => approvalUrlFor(prompt, "not a url")).toThrow(
      "approvalUrl is not a URL",
    );
    expect(() => approvalUrlFor(prompt, () => "/relative")).toThrow(
      "approvalUrl is not a URL",
    );
  });
});

describe("webhookTransport edge cases", () => {
  it("fails invalid-message without a request when the event cannot be serialised", async () => {
    const requests: unknown[] = [];
    const transport = webhookTransport(
      webhookSigner({
        keys: [{ alg: "v1", secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" }],
      }),
      {
        fetch: async (input) => {
          requests.push(input);
          return new Response(null, { status: 204 });
        },
      },
    );
    const event: CloudEvent = Object.assign(
      toCloudEvent(
        deliveryEvent({
          source: "https://acme.test",
          operation: "sent",
          channel: "webhook",
          delivery: { id: "dlv_1", key: "pdd_1" },
        }),
        { source: "https://acme.test", id: "evt_1" },
      ),
      {
        toJSON(): never {
          throw new Error("not serialisable");
        },
      },
    );
    const permdock = await sender();
    const decision = permdock.decide(p.invoice.read, invoice, {
      trusted: true,
    });
    if (decision.outcome !== "granted") {
      throw new Error("expected granted");
    }
    const target: DeliveryTarget<"webhook"> = {
      channel: "webhook",
      address: "https://hooks.customer.test/permdock",
      principal: "u_1",
      decision,
    };
    expect(
      await transport.deliver(
        target,
        { event },
        { idempotencyKey: "pdd_key", delivery: "dlv_1" },
      ),
    ).toEqual({ status: "failed", cause: "invalid-message", retryable: false });
    expect(requests).toEqual([]);
  });
});
