import { describe, expect, it } from "vitest";

import type { SinkEvent } from "../../src/core/event-types.ts";
import type { EmailMessage } from "../../src/delivery/index.ts";

import { memoryDecisionSink } from "../../src/core/sink.ts";
import {
  createPermDock,
  memoryDeliveryTransport,
} from "../../src/delivery/index.ts";
import {
  deliveryOperations,
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

function setup() {
  const sink = memoryDecisionSink();
  const mail = memoryDeliveryTransport("email");
  const chat = memoryDeliveryTransport("chat");
  const delivery = createPermDock(deliveryPolicy, {
    transports: { email: mail, chat },
    principals: deliveryPrincipals,
    sink,
    from: "billing@acme.test",
  });
  return { sink, mail, chat, delivery };
}

function deliveryEvents(events: readonly SinkEvent[]) {
  return events.filter((event) => event.type === "delivery");
}

describe("createPermDock (delivery)", () => {
  it("sends to a granted principal and refuses one outside the tenant", async () => {
    const { sink, mail, delivery } = setup();
    const report = await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      [
        { principal: "u_2", channel: "email", address: "ann@acme.test" },
        { principal: "u_3", channel: "email", address: "otto@globex.test" },
      ],
      { email },
    );
    expect(report.sent).toBe(1);
    expect(report.failed).toBe(1);
    expect(mail.deliveries).toHaveLength(1);
    expect(mail.deliveries[0]?.target).toMatchObject({
      channel: "email",
      address: "ann@acme.test",
      principal: "u_2",
      decision: { outcome: "granted" },
    });
    const [sent, failed] = deliveryEvents(sink.events());
    expect(sent).toMatchObject({
      type: "delivery",
      operation: "sent",
      channel: "email",
      recipient: { principal: { id: "u_2" } },
      permission: "invoice.read",
      tenant: "o1",
      category: "transactional",
      provider: { name: "memory" },
      delivery: { id: report.id },
    });
    expect(failed).toMatchObject({
      operation: "failed",
      cause: "denied",
      retryable: false,
      reason: "tenant-mismatch",
      recipient: { principal: { id: "u_3" } },
    });
    expect(JSON.stringify(sink.events())).not.toContain("ann@acme.test");
  });

  it("decides the permission of an operation", async () => {
    const { mail, delivery } = setup();
    const report = await delivery.deliver(
      await sender(),
      deliveryOperations["invoice.send"],
      invoice,
      [{ principal: "u_2", channel: "email", address: "ann@acme.test" }],
      { email },
    );
    expect(report.sent).toBe(1);
    expect(mail.deliveries[0]?.target.decision.matched.permission).toBe(
      "invoice.read",
    );
  });

  it("resolves an address through principalByIdentity", async () => {
    const { sink, mail, chat, delivery } = setup();
    const report = await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      [
        { address: "  Ann@Acme.test ", channel: "email" },
        { address: "cleo@client.test", channel: "email" },
        { address: "U2", channel: "chat", provider: "slack", workspace: "T1" },
        { address: "stranger@else.test", channel: "email" },
      ],
      { email, chat: { text: "Invoice i1 is ready." } },
    );
    expect(report.sent).toBe(3);
    expect(
      mail.deliveries.map((entry) => entry.target.principal),
    ).toStrictEqual(["u_2", "c_1"]);
    expect(mail.deliveries[0]?.target.address).toBe("ann@acme.test");
    expect(chat.deliveries[0]?.target).toMatchObject({
      address: "U2",
      provider: "slack",
      workspace: "T1",
      principal: "u_2",
    });
    expect(deliveryEvents(sink.events()).at(-1)).toMatchObject({
      operation: "failed",
      cause: "unlinked",
      retryable: false,
    });
  });

  it("sends to a trusted address only when the sender is granted", async () => {
    const { sink, mail, delivery } = setup();
    const recipient = {
      address: "accounts@customer.test",
      channel: "email",
      trusted: true,
    } as const;
    const granted = await delivery.deliver(
      await sender(),
      p.invoice.pay,
      invoice,
      [recipient],
      { email },
    );
    expect(granted.sent).toBe(1);
    expect(mail.deliveries[0]?.target).toMatchObject({ trusted: true });
    expect(mail.deliveries[0]?.target.principal).toBeUndefined();
    expect(deliveryEvents(sink.events())[0]).toMatchObject({
      recipient: { trusted: true },
    });
    const refused = await delivery.deliver(
      await sender("u_2"),
      p.invoice.pay,
      invoice,
      [recipient],
      { email },
    );
    expect(refused.failed).toBe(1);
    expect(deliveryEvents(sink.events()).at(-1)).toMatchObject({
      operation: "failed",
      cause: "denied",
    });
  });

  it("fails a recipient with no transport or no message for its channel", async () => {
    const { sink, delivery } = setup();
    await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      [
        { principal: "u_2", channel: "webhook", address: "https://a.test/h" },
        { principal: "u_2", channel: "chat", address: "U2" },
      ],
      { email },
    );
    expect(
      deliveryEvents(sink.events()).map((event) =>
        event.type === "delivery" ? event.cause : undefined,
      ),
    ).toStrictEqual(["no-transport", "no-message"]);
  });

  it("refuses an address that is not an addr-spec", async () => {
    const { sink, mail, delivery } = setup();
    await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      [
        { principal: "u_2", channel: "email", address: "Ann <ann@acme.test>" },
        {
          principal: "u_2",
          channel: "email",
          address: "ann@acme.test\r\nBcc: x@y.test",
        },
      ],
      { email },
    );
    expect(mail.deliveries).toStrictEqual([]);
    expect(
      deliveryEvents(sink.events()).every(
        (event) =>
          event.type === "delivery" && event.cause === "invalid-recipient",
      ),
    ).toBe(true);
  });

  it("derives a stable idempotency key per delivery id and recipient", async () => {
    const { mail, delivery } = setup();
    const recipients = [
      { principal: "u_2", channel: "email", address: "ann@acme.test" },
      { principal: "u_1", channel: "email", address: "bob@acme.test" },
    ] as const;
    const permdock = await sender();
    await delivery.deliver(
      permdock,
      p.invoice.read,
      invoice,
      recipients,
      { email },
      { id: "dlv_fixed" },
    );
    await delivery.deliver(
      permdock,
      p.invoice.read,
      invoice,
      recipients,
      { email },
      { id: "dlv_fixed" },
    );
    const keys = mail.deliveries.map((entry) => entry.options.idempotencyKey);
    expect(keys[0]).toMatch(/^pdd_[A-Za-z0-9_-]{43}$/u);
    expect(keys[0]).toBe(keys[2]);
    expect(keys[1]).toBe(keys[3]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(mail.deliveries[0]?.options.delivery).toBe("dlv_fixed");
  });

  it("maps a transport failure and a throw to failed events", async () => {
    const sink = memoryDecisionSink();
    const delivery = createPermDock(deliveryPolicy, {
      transports: {
        email: memoryDeliveryTransport("email", {
          respond: (target) =>
            target.principal === "u_2"
              ? { status: "failed", cause: "rate-limited", retryable: true }
              : { status: "sent", providerId: "m_1" },
        }),
        chat: {
          channel: "chat",
          name: "broken",
          deliver: () => {
            throw new Error("socket closed");
          },
        },
      },
      principals: deliveryPrincipals,
      sink,
    });
    const report = await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      [
        { principal: "u_2", channel: "email", address: "ann@acme.test" },
        { principal: "u_1", channel: "email", address: "bob@acme.test" },
        { principal: "u_2", channel: "chat", address: "U2" },
      ],
      { email: { ...email, from: "billing@acme.test" }, chat: { text: "hi" } },
    );
    expect(report.sent).toBe(1);
    expect(deliveryEvents(sink.events())).toMatchObject([
      { operation: "failed", cause: "rate-limited", retryable: true },
      { operation: "sent", provider: { name: "memory", id: "m_1" } },
      {
        operation: "failed",
        cause: "unavailable",
        retryable: true,
        provider: { name: "broken" },
      },
    ]);
  });

  it("sends two or more ready recipients through deliverBatch in chunks", async () => {
    const batches: number[] = [];
    const delivery = createPermDock(deliveryPolicy, {
      transports: {
        email: {
          channel: "email",
          name: "batcher",
          batchSize: 2,
          deliver: () => ({ status: "sent", providerId: "single" }),
          deliverBatch: (items) => {
            batches.push(items.length);
            return items.map((item) =>
              item.target.principal === "c_1"
                ? { status: "failed", cause: "suppressed", retryable: false }
                : { status: "sent", providerId: `b_${item.target.principal}` },
            );
          },
        },
      },
      principals: deliveryPrincipals,
      from: "billing@acme.test",
    });
    const report = await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      [
        { principal: "u_2", channel: "email", address: "ann@acme.test" },
        { principal: "u_3", channel: "email", address: "otto@globex.test" },
        { principal: "u_1", channel: "email", address: "bob@acme.test" },
        { principal: "c_1", channel: "email", address: "cleo@client.test" },
      ],
      { email },
    );
    expect(batches).toStrictEqual([2, 1]);
    expect(
      report.events.map((event) => event.provider?.id ?? event.cause),
    ).toStrictEqual(["b_u_2", "denied", "b_u_1", "suppressed"]);
  });

  it("fails every item of a batch that throws or returns the wrong count", async () => {
    for (const deliverBatch of [
      () => {
        throw new Error("down");
      },
      () => [{ status: "sent" as const }],
    ]) {
      const delivery = createPermDock(deliveryPolicy, {
        transports: {
          email: {
            channel: "email",
            name: "batcher",
            deliver: () => ({ status: "sent" }),
            deliverBatch,
          },
        },
        principals: deliveryPrincipals,
        from: "billing@acme.test",
      });
      const report = await delivery.deliver(
        await sender(),
        p.invoice.read,
        invoice,
        [
          { principal: "u_2", channel: "email", address: "ann@acme.test" },
          { principal: "u_1", channel: "email", address: "bob@acme.test" },
        ],
        { email },
      );
      expect(report.events).toMatchObject([
        { cause: "unavailable", retryable: true },
        { cause: "unavailable", retryable: true },
      ]);
    }
  });

  it("never rejects when the sink throws", async () => {
    const delivery = createPermDock(deliveryPolicy, {
      transports: { email: memoryDeliveryTransport("email") },
      principals: deliveryPrincipals,
      sink: {
        write: () => {
          throw new Error("sink down");
        },
      },
      from: "billing@acme.test",
    });
    const report = await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      [{ principal: "u_2", channel: "email", address: "ann@acme.test" }],
      { email },
    );
    expect(report.sent).toBe(1);
  });

  it("returns the events it wrote, in recipient order", async () => {
    const { delivery } = setup();
    const report = await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      [
        { principal: "u_3", channel: "email", address: "otto@globex.test" },
        { principal: "u_2", channel: "email", address: "ann@acme.test" },
      ],
      { email },
      { approval: "apr_1" },
    );
    expect(report.events.map((event) => event.operation)).toStrictEqual([
      "failed",
      "sent",
    ]);
    expect(report.events[1]?.approval).toBe("apr_1");
    expect(Object.isFrozen(report)).toBe(true);
  });
});

describe("email standards", () => {
  async function sendWith(message: EmailMessage) {
    const { sink, mail, delivery } = setup();
    await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      [{ principal: "u_2", channel: "email", address: "ann@acme.test" }],
      { email: message },
    );
    return { sink, sent: mail.deliveries[0]?.message };
  }

  it("marks every message Auto-Submitted and keeps the sender's from", async () => {
    const { sent } = await sendWith(email);
    expect(sent?.headers).toStrictEqual({ "Auto-Submitted": "auto-generated" });
    expect(sent?.from).toBe("billing@acme.test");
  });

  it("adds List-Unsubscribe and List-Unsubscribe-Post to a notification", async () => {
    const { sent } = await sendWith({
      ...email,
      category: "notification",
      unsubscribe: {
        url: "https://acme.test/unsubscribe?t=abc",
        mailto: "unsubscribe@acme.test",
      },
    });
    expect(sent?.headers).toStrictEqual({
      "Auto-Submitted": "auto-generated",
      "List-Unsubscribe":
        "<https://acme.test/unsubscribe?t=abc>, <mailto:unsubscribe@acme.test>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("builds the unsubscribe link per recipient", async () => {
    const { sent } = await sendWith({
      ...email,
      category: "notification",
      unsubscribe: (target) => ({
        url: `https://acme.test/unsubscribe/${target.principal ?? "x"}`,
      }),
    });
    expect(sent?.headers?.["List-Unsubscribe"]).toBe(
      "<https://acme.test/unsubscribe/u_2>",
    );
  });

  it("refuses a notification without an https unsubscribe link", async () => {
    for (const unsubscribe of [
      undefined,
      { url: "http://acme.test/unsubscribe" },
    ]) {
      const { sink, sent } = await sendWith({
        ...email,
        category: "notification",
        ...(unsubscribe === undefined ? {} : { unsubscribe }),
      });
      expect(sent).toBeUndefined();
      expect(deliveryEvents(sink.events())[0]).toMatchObject({
        cause: "invalid-message",
      });
    }
  });

  it("never sets List-Unsubscribe on approval or security mail", async () => {
    for (const category of ["approval", "security"] as const) {
      const { sent } = await sendWith({
        ...email,
        category,
        unsubscribe: { url: "https://acme.test/u" },
        headers: {
          "list-unsubscribe": "<https://evil.test>",
          "X-Entity-Ref-ID": "i1",
        },
      });
      expect(sent?.headers).toStrictEqual({
        "Auto-Submitted": "auto-generated",
        "X-Entity-Ref-ID": "i1",
      });
    }
  });

  it("refuses a header or subject with a line break", async () => {
    for (const message of [
      { ...email, subject: "Hi\r\nBcc: x@y.test" },
      { ...email, headers: { "X-Ref": "a\nb" } },
      { ...email, headers: { "Bad Name": "a" } },
    ]) {
      const { sink, sent } = await sendWith(message);
      expect(sent).toBeUndefined();
      expect(deliveryEvents(sink.events())[0]).toMatchObject({
        cause: "invalid-message",
      });
    }
  });

  it("fails an email with no from address", async () => {
    const sink = memoryDecisionSink();
    const delivery = createPermDock(deliveryPolicy, {
      transports: { email: memoryDeliveryTransport("email") },
      principals: deliveryPrincipals,
      sink,
    });
    await delivery.deliver(
      await sender(),
      p.invoice.read,
      invoice,
      [{ principal: "u_2", channel: "email", address: "ann@acme.test" }],
      { email },
    );
    expect(deliveryEvents(sink.events())[0]).toMatchObject({
      cause: "invalid-message",
    });
  });
});

describe(memoryDeliveryTransport, () => {
  it("refuses a target without a granted decision", async () => {
    const mail = memoryDeliveryTransport("email");
    const result = await mail.deliver(
      // SAFETY: a forged target, the case the transport must refuse.
      { channel: "email", address: "ann@acme.test" } as never,
      {
        from: "a@b.test",
        subject: "Hi",
        text: "Hi",
        category: "transactional",
        headers: {},
      },
      { idempotencyKey: "pdd_x", delivery: "dlv_x" },
    );
    expect(result).toStrictEqual({
      status: "failed",
      cause: "invalid-recipient",
      retryable: false,
    });
    expect(mail.deliveries).toStrictEqual([]);
  });
});
