import { describe, expect, it } from "vitest";

import type {
  EmailCategory,
  EmailMessage,
  OutgoingEmail,
} from "../../src/delivery/index.ts";

import {
  createPermDock,
  isAddrSpec,
  memoryDeliveryTransport,
} from "../../src/delivery/index.ts";
import {
  deliveryPermissions,
  deliveryPolicy,
  invoice,
  sender,
} from "../fixtures/delivery.ts";

const FROM = "Acme <billing@acme.test>";

async function send(
  message: Partial<EmailMessage>,
): Promise<{
  readonly email?: OutgoingEmail;
  readonly reason?: string | undefined;
}> {
  const transport = memoryDeliveryTransport("email");
  const delivery = createPermDock(deliveryPolicy, {
    transports: { email: transport },
    from: FROM,
  });
  const report = await delivery.deliver(
    await sender(),
    deliveryPermissions.invoice.read,
    invoice,
    [{ principal: "u_2", channel: "email", address: "ann@acme.test" }],
    {
      email: {
        subject: "Invoice i1",
        text: "Invoice i1 is ready.",
        category: "transactional",
        ...message,
      },
    },
  );
  const event = report.events[0];
  const reason =
    event !== undefined && "reason" in event && typeof event.reason === "string"
      ? event.reason
      : undefined;
  // SAFETY: an email transport records OutgoingEmail messages.
  const email = transport.deliveries[0]?.message as OutgoingEmail | undefined;
  return email === undefined ? { reason } : { email };
}

describe("RFC 3834 Auto-Submitted", () => {
  it("marks every category auto-generated", async () => {
    const categories: readonly EmailCategory[] = [
      "transactional",
      "security",
      "approval",
    ];
    for (const category of categories) {
      const { email } = await send({ category });
      expect(email?.headers["Auto-Submitted"]).toBe("auto-generated");
    }
  });

  it("keeps a caller from removing or replacing it", async () => {
    const { email } = await send({
      headers: { "auto-submitted": "no", "X-Entity-Ref-ID": "i1" },
    });
    expect(email?.headers).toStrictEqual({
      "Auto-Submitted": "auto-generated",
      "X-Entity-Ref-ID": "i1",
    });
  });
});

describe("RFC 2369 and RFC 8058 one-click unsubscribe", () => {
  it("adds List-Unsubscribe and List-Unsubscribe-Post to a notification", async () => {
    const { email } = await send({
      category: "notification",
      unsubscribe: {
        url: "https://acme.test/unsubscribe?u=ann",
        mailto: "unsubscribe@acme.test",
      },
    });
    expect(email?.headers["List-Unsubscribe"]).toBe(
      "<https://acme.test/unsubscribe?u=ann>, <mailto:unsubscribe@acme.test>",
    );
    expect(email?.headers["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
  });

  it("refuses a notification without an https unsubscribe URI", async () => {
    expect((await send({ category: "notification" })).reason).toContain(
      "RFC 8058",
    );
    expect(
      (
        await send({
          category: "notification",
          unsubscribe: { url: "http://acme.test/unsubscribe" },
        })
      ).reason,
    ).toContain("RFC 8058");
  });

  it("leaves the pair off transactional, security and approval mail", async () => {
    const { email } = await send({
      category: "security",
      unsubscribe: { url: "https://acme.test/unsubscribe" },
      headers: { "List-Unsubscribe": "<https://evil.test>" },
    });
    expect(email?.headers["List-Unsubscribe"]).toBeUndefined();
    expect(email?.headers["List-Unsubscribe-Post"]).toBeUndefined();
  });
});

describe("RFC 5322 header fields and addresses", () => {
  it("refuses a header value or subject with a line break", async () => {
    expect(
      (await send({ headers: { "X-Note": "a\r\nBcc: evil@evil.test" } }))
        .reason,
    ).toContain("single-line");
    expect((await send({ subject: "Hi\nBcc: evil@evil.test" })).reason).toBe(
      "subject is empty or has a line break",
    );
  });

  it("refuses a field name outside printable ASCII or with a colon", async () => {
    expect((await send({ headers: { "X:Bad": "1" } })).reason).toContain(
      "single-line",
    );
    expect((await send({ headers: { "X Bad": "1" } })).reason).toContain(
      "single-line",
    );
  });

  it("refuses envelope fields in headers", async () => {
    for (const name of ["Bcc", "cc", "To", "Reply-To", "Return-Path"]) {
      expect((await send({ headers: { [name]: "x@acme.test" } })).reason).toBe(
        `header ${name} is set through the message, not headers`,
      );
    }
  });

  it("accepts an addr-spec or a name-addr for from", async () => {
    expect((await send({ from: "billing@acme.test" })).email?.from).toBe(
      "billing@acme.test",
    );
    expect((await send({ from: "Acme <billing@acme.test>" })).email?.from).toBe(
      "Acme <billing@acme.test>",
    );
    expect((await send({ from: "Acme <not an address>" })).reason).toBe(
      "from is not a mailbox",
    );
  });

  it("accepts dot-atom addr-specs on a DNS domain only", () => {
    expect(isAddrSpec("ann.lee+bills@mail.acme.test")).toBe(true);
    expect(isAddrSpec("ann@acme")).toBe(false);
    expect(isAddrSpec("ann..lee@acme.test")).toBe(false);
    expect(isAddrSpec('"ann lee"@acme.test')).toBe(false);
    expect(isAddrSpec(`${"a".repeat(250)}@acme.test`)).toBe(false);
  });
});
