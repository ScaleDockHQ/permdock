import type { ActionEvent } from "chat";

import type { ChatActionResult, ChatPermDock } from "../chat/create.ts";
import type { ChatSdkAuthorOptions } from "./author.ts";

import { chatSdkAuthor } from "./author.ts";
import { APPROVE_ACTION, REJECT_ACTION } from "./card.ts";

export type ApprovalActionsOptions = ChatSdkAuthorOptions & {
  /**
   * Receives every verdict instead of the default replies: the outcome posted
   * to the thread, a refusal shown only to the clicking user.
   */
  readonly onResult?: (
    result: ChatActionResult,
    event: ActionEvent,
  ) => void | Promise<void>;
};

export type ApprovalActions = {
  /**
   * The action ids to register: `chat.onAction(actions.actionIds,
   * actions.onAction)`.
   */
  readonly actionIds: readonly [typeof APPROVE_ACTION, typeof REJECT_ACTION];
  readonly onAction: (event: ActionEvent) => Promise<void>;
};

async function reply(
  result: ChatActionResult,
  event: ActionEvent,
): Promise<void> {
  const { thread } = event;
  if (thread === null) {
    return;
  }
  if (result.ok) {
    const verdict = result.status === "approved" ? "Approved" : "Rejected";
    await thread.post(`${verdict} by ${event.user.userName}.`);
    return;
  }
  await thread.postEphemeral(
    event.user,
    `The approval was not recorded: ${result.cause}.`,
    { fallbackToDM: false },
  );
}

/**
 * Applies the approve and reject buttons of `approvalCard`. The clicking user,
 * as the Chat SDK adapter verified them, is resolved through
 * `ChatPermDock.resolveAction`; the button value names the request by id. A
 * click from an unlinked user, the requester or a bot records nothing.
 */
export function approvalActions(
  permdock: ChatPermDock,
  options: ApprovalActionsOptions = {},
): ApprovalActions {
  const onAction = async (event: ActionEvent): Promise<void> => {
    if (event.actionId !== APPROVE_ACTION && event.actionId !== REJECT_ACTION) {
      return;
    }
    const author = chatSdkAuthor(event.user, event.adapter, options);
    const result = await permdock.resolveAction(author, {
      approval: event.value ?? "",
      status: event.actionId === APPROVE_ACTION ? "approved" : "rejected",
    });
    await (options.onResult ?? reply)(result, event);
  };
  return Object.freeze({
    actionIds: [APPROVE_ACTION, REJECT_ACTION] as const,
    onAction,
  });
}
