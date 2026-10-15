import type { Adapter } from "chat";
import type { ChatCommandResult } from "permdock/chat";
import type { Recipient } from "permdock/delivery";

import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";
import { whoCan } from "permdock";
import { memoryApprovalStore } from "permdock/approvals";
import { createPermDock } from "permdock/chat";
import {
  approvalActions,
  chatSdkAuthor,
  chatSdkTransport,
} from "permdock/chat-sdk";
import { audience, createPermDock as createDelivery } from "permdock/delivery";

import { operations, permissions } from "./permissions.ts";
import {
  WORKSPACE,
  memberships,
  policy,
  principals,
  slackIds,
} from "./policy.ts";

const APPROVALS = "https://app.acme.test/approvals";

// SAFETY: SlackAdapter types `botUserId` as `string | undefined`, which `Adapter` accepts only without exactOptionalPropertyTypes.
const slack = createSlackAdapter() as Adapter;

export const chat = new Chat<{ readonly slack: Adapter }>({
  userName: "acme-billing",
  adapters: { slack },
  state: createMemoryState(),
});

const approvals = memoryApprovalStore();
const permdock = createPermDock(policy, {
  principals,
  memberships,
  approvals,
});
const delivery = createDelivery(policy, {
  transports: {
    chat: chatSdkTransport(chat, { provider: "slack", workspace: WORKSPACE }),
  },
  principals,
});

const show = permdock.protect(
  operations["invoice.show"],
  ({ row }) => `Invoice: ${JSON.stringify(row)}`,
);
const pay = permdock.protect(
  operations["invoice.pay"],
  ({ input }) => `Paid ${input.id}.`,
);

function recipient(principal: string): Recipient {
  return {
    principal,
    channel: "chat",
    address: slackIds[principal] ?? "",
    provider: "slack",
    workspace: WORKSPACE,
  };
}

function replyFor(result: ChatCommandResult<string>): string {
  switch (result.outcome) {
    case "granted":
      return result.value;
    case "denied":
      return `Not allowed (${result.decision.denials[0]?.reason ?? "denied"}).`;
    case "approval-required":
      return "This needs an approval. The approvers have been asked.";
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

chat.onNewMention(async (thread, message) => {
  const author = chatSdkAuthor(message.author, thread.adapter, {
    workspace: WORKSPACE,
  });
  const [verb = "", id = ""] = message.text.trim().split(/\s+/u).slice(-2);
  const run = verb === "pay" ? pay : show;
  const result = await run(author, { id });
  if (result.outcome === "approval-required" && result.prompt !== null) {
    const requester = await permdock.getPermDock(author);
    const holders = await whoCan(requester, permissions.invoice.pay, {
      id,
      orgId: "acme",
    });
    const approvers = await audience(
      requester,
      permissions.invoice.read,
      { id, orgId: "acme" },
      {
        candidates: holders.holders
          .map((holder) => holder.principal.id)
          .filter((holder) => holder !== requester.subject.principal?.id),
      },
    );
    await delivery.deliver(
      requester,
      permissions.invoice.read,
      { id, orgId: "acme" },
      approvers.principals.map(recipient),
      {
        chat: {
          text: result.prompt.detail,
          approval: { prompt: result.prompt, url: APPROVALS },
        },
      },
      { approval: result.prompt.id },
    );
  }
  await thread.post(replyFor(result));
});

const actions = approvalActions(permdock, { workspace: WORKSPACE });
chat.onAction([...actions.actionIds], actions.onAction);
