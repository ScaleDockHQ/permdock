import type { CardChild, CardElement } from "chat";

import {
  Actions,
  Button,
  Card,
  CardText,
  Field,
  Fields,
  LinkButton,
} from "chat";

import type {
  ApprovalPrompt,
  ApprovalUrl,
} from "../delivery/approval-prompt.ts";

import { approvalUrlFor } from "../delivery/approval-prompt.ts";

/** The `actionId` of the card's approve button; its `value` is the request id. */
export const APPROVE_ACTION = "permdock:approve";
/** The `actionId` of the card's reject button; its `value` is the request id. */
export const REJECT_ACTION = "permdock:reject";

export type ApprovalCardOptions = {
  /** The app's approval page: a base URL the request id is appended to, or a function of the prompt. Must be https. */
  readonly approvalUrl: ApprovalUrl;
  /** `false` leaves out the approve and reject buttons, so the page is the only place to decide. Defaults to `true`. */
  readonly buttons?: boolean;
};

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

/**
 * A Chat SDK card for an approval prompt: the detail, who asked, the
 * permission and the expiry, a link to the approval page, and approve and
 * reject buttons that carry the request id, never its token. A click is
 * applied by `approvalActions` as the verified clicking user. Throws a
 * `TypeError` for an approval page that is not https.
 */
export function approvalCard(
  prompt: ApprovalPrompt,
  options: ApprovalCardOptions,
): CardElement {
  const url = approvalUrlFor(prompt, options.approvalUrl);
  const requester = prompt.requester.principal?.id ?? "an anonymous caller";
  const actor = prompt.requester.actor;
  const fields = [
    Field({
      label: "Requested by",
      value:
        actor === undefined
          ? requester
          : `${requester} through ${actor.kind} ${actor.id}`,
    }),
    Field({ label: "Permission", value: prompt.permission }),
    Field({
      label: "Resource",
      value:
        prompt.resource.id === undefined
          ? prompt.resource.type
          : `${prompt.resource.type} ${prompt.resource.id}`,
    }),
    ...(prompt.operation?.risk === undefined
      ? []
      : [Field({ label: "Risk", value: prompt.operation.risk })]),
    Field({ label: "Expires", value: prompt.expiresAt }),
  ];
  const review = LinkButton({ url, label: "Review" });
  const children: CardChild[] = [
    CardText(oneLine(prompt.detail)),
    Fields(fields),
    Actions(
      options.buttons === false
        ? [review]
        : [
            Button({
              id: APPROVE_ACTION,
              label: "Approve",
              style: "primary",
              value: prompt.id,
            }),
            Button({
              id: REJECT_ACTION,
              label: "Reject",
              style: "danger",
              value: prompt.id,
            }),
            review,
          ],
    ),
  ];
  return Card({
    title: `Approval needed: ${oneLine(prompt.operation?.title ?? prompt.detail)}`,
    children,
  });
}
