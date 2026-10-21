import type { ActionEvent } from "chat";

import { describe, expect, it } from "vitest";

import type { ChatSdkClient } from "../../src/chat-sdk/index.ts";
import type {
  ApprovalPrompt,
  DeliveryTarget,
} from "../../src/delivery/index.ts";

import { memoryApprovalStore } from "../../src/approvals/index.ts";
import {
  APPROVE_ACTION,
  approvalActions,
  chatSdkTransport,
} from "../../src/chat-sdk/index.ts";
import { createPermDock } from "../../src/chat/index.ts";
import {
  billing,
  chatMemberships,
  chatOperations,
  chatPolicy,
  chatPrincipals,
} from "../fixtures/chat.ts";

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

function fakeChat(): {
  readonly client: ChatSdkClient;
  readonly posted: Posted[];
} {
  const posted: Posted[] = [];
  const client: ChatSdkClient = {
    openDM(user) {
      return Promise.resolve({
        post(message) {
          posted.push({ user, message });
          return Promise.resolve({ id: `m_${posted.length}` });
        },
      });
    },
  };
  return { client, posted };
}

function target(): DeliveryTarget<"chat"> {
  // SAFETY: a granted decision shaped like the router's, for a unit test of the transport alone.
  return {
    channel: "chat",
    address: "U2",
    principal: "u_2",
    provider: "slack",
    decision: {
      outcome: "granted",
      subject: { principal: { id: "u_2" }, context: {} },
      matched: {
        role: "member",
        permission: "invoice.read",
        to: { kind: "role", role: "member" },
      },
    },
  } as DeliveryTarget<"chat">;
}

function key(idempotencyKey: string) {
  return { idempotencyKey, delivery: "dlv_1" };
}

function threadlessEvent(value: string): ActionEvent {
  // SAFETY: the fields approvalActions reads from a Chat SDK action event that arrived outside a thread.
  return {
    actionId: APPROVE_ACTION,
    adapter: { name: "slack" },
    messageId: "m_0",
    threadId: "slack:C1:1",
    thread: null,
    user: {
      userId: "U3",
      userName: "U3",
      fullName: "U3",
      isBot: false,
      isMe: false,
    },
    value,
    raw: {},
    openModal: () => Promise.resolve(undefined),
  } as unknown as ActionEvent;
}

describe("approvalActions without a thread", () => {
  it("records the verdict and posts nothing", async () => {
    const store = memoryApprovalStore();
    const chat = createPermDock(chatPolicy, {
      principals: chatPrincipals,
      memberships: chatMemberships,
      store: store,
    });
    const pay = chat.protect(chatOperations["invoice.pay"], () => "paid");
    const first = await pay(billing, { id: "i1" });
    const id =
      first.outcome === "approval-required" ? (first.prompt?.id ?? "") : "";
    const actions = approvalActions(chat, { workspace: "T1" });
    await expect(
      actions.onAction(threadlessEvent(id)),
    ).resolves.toBeUndefined();
    expect((await store.getById?.(id))?.status).toBe("approved");
    expect(await pay(billing, { id: "i1" })).toStrictEqual({
      outcome: "granted",
      value: "paid",
    });
  });
});

describe("chatSdkTransport edge cases", () => {
  it("forgets the oldest key once it remembers more than remember keys", async () => {
    const { client, posted } = fakeChat();
    const transport = chatSdkTransport(client, {
      provider: "slack",
      remember: 1,
    });
    await transport.deliver(target(), { text: "a" }, key("pdd_a"));
    await transport.deliver(target(), { text: "b" }, key("pdd_b"));
    expect(
      await transport.deliver(target(), { text: "b" }, key("pdd_b")),
    ).toStrictEqual({ status: "sent", providerId: "m_2" });
    expect(
      await transport.deliver(target(), { text: "a" }, key("pdd_a")),
    ).toStrictEqual({ status: "sent", providerId: "m_3" });
    expect(posted.map((entry) => entry.message)).toStrictEqual(["a", "b", "a"]);
  });

  it("fails an approval message whose card cannot be built without posting", async () => {
    const { client, posted } = fakeChat();
    const transport = chatSdkTransport(client, { provider: "slack" });
    expect(
      await transport.deliver(
        target(),
        {
          text: "Approval needed",
          approval: { prompt, url: "http://acme.test/approvals" },
        },
        key("pdd_card"),
      ),
    ).toStrictEqual({
      status: "failed",
      cause: "invalid-message",
      retryable: false,
    });
    expect(posted).toStrictEqual([]);
  });
});
