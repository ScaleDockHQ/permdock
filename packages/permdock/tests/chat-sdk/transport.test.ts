import type { CardElement } from "chat";

import { describe, expect, it } from "vitest";

import type { ChatSdkClient } from "../../src/chat-sdk/index.ts";
import type {
  ApprovalPrompt,
  ChatTransport,
  DeliveryTarget,
} from "../../src/delivery/index.ts";

import { approvalCard, chatSdkTransport } from "../../src/chat-sdk/index.ts";
import { testDeliveryTransport } from "../../src/testing/index.ts";

const prompt: ApprovalPrompt = {
  v: 1,
  id: "apr_1",
  permission: "invoice.pay",
  scope: "tenant",
  resource: { type: "invoice", id: "i1" },
  requester: { principal: { id: "u_1" } },
  tenant: "o1",
  detail: "Pay invoice i1",
  createdAt: "2026-10-14T10:00:00.000Z",
  expiresAt: "2026-10-15T10:00:00.000Z",
  operation: { name: "invoice.pay", title: "Pay an invoice", risk: "high" },
};

type Posted = { readonly user: string; readonly message: unknown };

type FakeChat = {
  readonly client: ChatSdkClient;
  readonly posted: Posted[];
  failNext(error: Error): void;
};

function chatError(code: string): Error {
  return Object.assign(new Error(code), { name: "ChatError", code });
}

function fakeChat(): FakeChat {
  const posted: Posted[] = [];
  let failure: Error | undefined;
  const client: ChatSdkClient = {
    openDM(user) {
      if (failure !== undefined) {
        const error = failure;
        failure = undefined;
        return Promise.reject(error);
      }
      return Promise.resolve({
        post(message) {
          posted.push({ user, message });
          return Promise.resolve({ id: `m_${posted.length}` });
        },
      });
    },
  };
  return {
    client,
    posted,
    failNext(error) {
      failure = error;
    },
  };
}

const granted = {
  outcome: "granted" as const,
  subject: { principal: { id: "u_2" }, context: {} },
  matched: {
    role: "member",
    permission: "invoice.read",
    to: { kind: "role" as const, role: "member" },
  },
};

function target(
  overrides: {
    readonly [K in keyof DeliveryTarget<"chat">]?:
      | DeliveryTarget<"chat">[K]
      | undefined;
  } = {},
): DeliveryTarget<"chat"> {
  // SAFETY: a granted decision shaped like the router's, for a unit test of the transport alone.
  return {
    channel: "chat",
    address: "U2",
    principal: "u_2",
    provider: "slack",
    workspace: "T1",
    decision: granted,
    ...overrides,
  } as DeliveryTarget<"chat">;
}

function options(key = "pdd_k"): {
  readonly idempotencyKey: string;
  readonly delivery: string;
} {
  return { idempotencyKey: key, delivery: "dlv_1" };
}

describe("chatSdkTransport", () => {
  it("opens a DM with the address and posts the text", async () => {
    const { client, posted } = fakeChat();
    const transport = chatSdkTransport(client, {
      provider: "slack",
      workspace: "T1",
    });
    expect(transport.channel).toBe("chat");
    expect(transport.name).toBe("chat-sdk");
    const result = await transport.deliver(
      target(),
      { text: "Invoice i1 is ready" },
      options(),
    );
    expect(result).toEqual({ status: "sent", providerId: "m_1" });
    expect(posted).toEqual([{ user: "U2", message: "Invoice i1 is ready" }]);
  });

  it("posts an approval card that links to the approval page", async () => {
    const { client, posted } = fakeChat();
    const transport = chatSdkTransport(client, { provider: "slack" });
    await transport.deliver(
      target({ workspace: undefined }),
      {
        text: "Approval needed",
        approval: { prompt, url: "https://acme.test/approvals" },
      },
      options(),
    );
    // SAFETY: the transport posts a CardElement for an approval message.
    const card = posted[0]?.message as CardElement;
    expect(card.type).toBe("card");
    expect(JSON.stringify(card)).toContain("https://acme.test/approvals/apr_1");
  });

  it("posts a key it already sent only once", async () => {
    const { client, posted } = fakeChat();
    const transport = chatSdkTransport(client, { provider: "slack" });
    const first = await transport.deliver(
      target({ workspace: undefined }),
      { text: "x" },
      options("pdd_same"),
    );
    const again = await transport.deliver(
      target({ workspace: undefined }),
      { text: "x" },
      options("pdd_same"),
    );
    expect(again).toEqual(first);
    expect(posted).toHaveLength(1);
  });

  it("refuses a target for another platform or workspace", async () => {
    const { client, posted } = fakeChat();
    const transport = chatSdkTransport(client, {
      provider: "slack",
      workspace: "T1",
    });
    expect(
      await transport.deliver(
        target({ provider: "teams" }),
        { text: "x" },
        options(),
      ),
    ).toMatchObject({ status: "failed", cause: "rejected", retryable: false });
    expect(
      await transport.deliver(
        target({ workspace: "T2" }),
        { text: "x" },
        options(),
      ),
    ).toMatchObject({ status: "failed", cause: "rejected", retryable: false });
    expect(posted).toEqual([]);
  });

  it("maps Chat SDK error codes", async () => {
    const fake = fakeChat();
    const transport = chatSdkTransport(fake.client, { provider: "slack" });
    const send = (key: string) =>
      transport.deliver(
        target({ workspace: undefined }),
        { text: "x" },
        options(key),
      );
    fake.failNext(chatError("RATE_LIMITED"));
    expect(await send("a")).toMatchObject({
      cause: "rate-limited",
      retryable: true,
    });
    fake.failNext(chatError("NOT_IMPLEMENTED"));
    expect(await send("b")).toMatchObject({
      cause: "rejected",
      retryable: false,
    });
    fake.failNext(new Error("socket hang up"));
    expect(await send("c")).toMatchObject({
      cause: "unavailable",
      retryable: true,
    });
  });
});

describe("approvalCard", () => {
  it("has one link to the approval page and approve and reject buttons by request id", () => {
    const card = approvalCard(prompt, {
      approvalUrl: "https://acme.test/approvals",
    });
    const json = JSON.stringify(card);
    expect(card.title).toBe("Approval needed: Pay an invoice");
    expect(json).toContain('"url":"https://acme.test/approvals/apr_1"');
    expect(json).toContain('"id":"permdock:approve"');
    expect(json).toContain('"id":"permdock:reject"');
    expect(json).toContain('"value":"apr_1"');
    expect(json).not.toMatch(/token/iu);
  });

  it("leaves out the buttons when buttons is false", () => {
    const card = approvalCard(prompt, {
      approvalUrl: "https://acme.test/approvals",
      buttons: false,
    });
    expect(JSON.stringify(card)).not.toContain("permdock:approve");
  });

  it("throws for an approval page that is not https", () => {
    expect(() =>
      approvalCard(prompt, { approvalUrl: "http://acme.test/approvals" }),
    ).toThrow(TypeError);
  });
});

testDeliveryTransport("chatSdkTransport", {
  channel: "chat",
  address: "U2",
  message: { text: "hello" },
  create() {
    const fake = fakeChat();
    const inner = chatSdkTransport(fake.client, { provider: "slack" });
    const accepted: { readonly idempotencyKey: string }[] = [];
    const transport: ChatTransport = {
      ...inner,
      async deliver(deliveryTarget, message, deliveryOptions) {
        const before = fake.posted.length;
        const result = await inner.deliver(
          deliveryTarget,
          message,
          deliveryOptions,
        );
        if (fake.posted.length > before) {
          accepted.push({ idempotencyKey: deliveryOptions.idempotencyKey });
        }
        return result;
      },
    };
    return {
      transport,
      received: () => accepted,
      fail(kind) {
        fake.failNext(
          kind === "throw"
            ? new Error("down")
            : chatError(
                kind === "retryable" ? "RATE_LIMITED" : "NOT_IMPLEMENTED",
              ),
        );
      },
    };
  },
});
