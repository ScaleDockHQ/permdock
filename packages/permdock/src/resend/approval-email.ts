import type {
  ApprovalPrompt,
  ApprovalUrl,
  EmailMessage,
} from "../delivery/index.ts";

import { approvalUrlFor } from "../delivery/index.ts";

export type ApprovalEmailOptions = {
  /** The app's approval page: a base the request id is appended to, or a function of the prompt. Must be https. */
  readonly approvalUrl: ApprovalUrl;
  /** The product name in the footer line. */
  readonly product?: string;
};

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/gu, (char) => HTML_ESCAPES[char] ?? char);
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function requesterLine(prompt: ApprovalPrompt): string {
  const principal = prompt.requester.principal?.id ?? "an anonymous caller";
  const actor = prompt.requester.actor;
  return actor === undefined
    ? `Requested by ${principal}`
    : `Requested by ${principal} through ${actor.kind} ${actor.id}`;
}

/**
 * The default approval prompt email: an `approval`-category message whose
 * one link opens the app's approval page for the request. It carries no
 * approve or reject link; the signed-in approver decides on that page.
 * Throws a `TypeError` for an approval page that is not https. Replace it
 * with a React Email template by building the same `EmailMessage`.
 */
export function approvalEmail(
  prompt: ApprovalPrompt,
  options: ApprovalEmailOptions,
): EmailMessage {
  const url = approvalUrlFor(prompt, options.approvalUrl);
  const title = oneLine(prompt.operation?.title ?? prompt.detail);
  const resource =
    prompt.resource.id === undefined
      ? prompt.resource.type
      : `${prompt.resource.type} ${prompt.resource.id}`;
  const lines = [
    prompt.detail,
    "",
    `${requesterLine(prompt)}.`,
    `Permission: ${prompt.permission} on ${resource}`,
    ...(prompt.operation?.risk === undefined
      ? []
      : [`Risk: ${prompt.operation.risk}`]),
    `Expires ${prompt.expiresAt}`,
    "",
    `Review the request: ${url}`,
    "",
    `This link opens the approval page. Nothing is approved until you decide there${
      options.product === undefined ? "" : ` in ${options.product}`
    }.`,
  ];
  const facts = lines
    .slice(2, lines.indexOf("", 2))
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");
  const html = [
    `<p>${escapeHtml(prompt.detail)}</p>`,
    `<ul>${facts}</ul>`,
    `<p><a href="${escapeHtml(url)}">Review the request</a></p>`,
    `<p>${escapeHtml(lines.at(-1) ?? "")}</p>`,
  ].join("\n");
  return Object.freeze({
    subject: `Approval needed: ${title}`,
    text: lines.join("\n"),
    html,
    category: "approval",
  });
}
