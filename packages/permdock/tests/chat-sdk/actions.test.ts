import type { ActionEvent, Author } from "chat";

import { describe, expect, it } from "vitest";

import { memoryApprovalStore } from "../../src/approvals/index.ts";
import {
  APPROVE_ACTION,
  REJECT_ACTION,
  approvalActions,
} from "../../src/chat-sdk/index.ts";
import { createPermDock } from "../../src/chat/index.ts";
import {
  billing,
  chatMemberships,
  chatOperations,
  chatPolicy,
  chatPrincipals,
} from "../fixtures/chat.ts";

type Reply = { readonly kind: "post" | "ephemeral"; readonly text: unknown };

function user(userId: string, extra: Partial<Author> = {}): Author {
  return {
    userId,
    userName: userId,
    fullName: userId,
    isBot: false,
    isMe: false,
    ...extra,
  };
}

function event(
  actionId: string,
  author: Author,
  value: string | undefined,
  replies: Reply[],
): ActionEvent {
  const thread = {
    post(text: unknown) {
      replies.push({ kind: "post", text });
      return Promise.resolve({ id: "m_1" });
    },
    postEphemeral(_user: unknown, text: unknown) {
      replies.push({ kind: "ephemeral", text });
      return Promise.resolve(null);
    },
  };
  // SAFETY: the fields approvalActions reads from a Chat SDK action event.
  return {
    actionId,
    adapter: { name: "slack" },
    messageId: "m_0",
    threadId: "slack:C1:1",
    thread,
    user: author,
    value,
    raw: {},
    openModal: () => Promise.resolve(undefined),
  } as unknown as ActionEvent;
}

async function setup() {
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
  return { chat, store, id, pay };
}

describe(approvalActions, () => {
  it("names the approve and reject action ids", async () => {
    const { chat } = await setup();
    const actions = approvalActions(chat, { workspace: "T1" });
    expect(actions.actionIds).toStrictEqual([APPROVE_ACTION, REJECT_ACTION]);
  });

  it("approves as the clicking user and posts the outcome to the thread", async () => {
    const { chat, id, pay } = await setup();
    const actions = approvalActions(chat, { workspace: "T1" });
    const replies: Reply[] = [];
    await actions.onAction(event(APPROVE_ACTION, user("U3"), id, replies));
    expect(replies).toStrictEqual([{ kind: "post", text: "Approved by U3." }]);
    expect(await pay(billing, { id: "i1" })).toStrictEqual({
      outcome: "granted",
      value: "paid",
    });
  });

  it("tells only the clicking user why a verdict was refused", async () => {
    const { chat, id } = await setup();
    const actions = approvalActions(chat, { workspace: "T1" });
    const replies: Reply[] = [];
    await actions.onAction(event(APPROVE_ACTION, user("U1"), id, replies));
    await actions.onAction(event(APPROVE_ACTION, user("U9"), id, replies));
    await actions.onAction(
      event(APPROVE_ACTION, user("U3", { isBot: true }), id, replies),
    );
    expect(replies.map((reply) => reply.kind)).toStrictEqual([
      "ephemeral",
      "ephemeral",
      "ephemeral",
    ]);
    expect(String(replies[0]?.text)).toContain("approver-is-principal");
  });

  it("ignores other action ids and a missing request id", async () => {
    const { chat, store, id } = await setup();
    const actions = approvalActions(chat, { workspace: "T1" });
    const replies: Reply[] = [];
    await actions.onAction(event("other", user("U3"), id, replies));
    expect(replies).toStrictEqual([]);
    await actions.onAction(
      event(REJECT_ACTION, user("U3"), undefined, replies),
    );
    expect(String(replies[0]?.text)).toContain("invalid-action");
    expect((await store.getById?.(id))?.status).toBe("pending");
  });

  it("hands the result to onResult instead of replying", async () => {
    const { chat, id } = await setup();
    const results: unknown[] = [];
    const actions = approvalActions(chat, {
      workspace: "T1",
      onResult: (result) => {
        results.push(result);
      },
    });
    const replies: Reply[] = [];
    await actions.onAction(event(REJECT_ACTION, user("U3"), id, replies));
    expect(results).toStrictEqual([{ ok: true, id, status: "rejected" }]);
    expect(replies).toStrictEqual([]);
  });
});
