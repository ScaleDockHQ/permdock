import type { ApprovalRequest } from "../approvals/types.ts";
import type { Operation, OperationMeta } from "../core/operations.ts";

import { compact } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";

/**
 * What an email or chat prompt shows an approver, wire format v1. It carries no
 * approval token and no roles: a prompt links to the app's approval page, where
 * the signed-in approver decides. A link never approves.
 */
export type ApprovalPrompt = {
  readonly v: 1;
  /** The approval request id. */
  readonly id: string;
  readonly permission: string;
  readonly scope: string;
  readonly resource: { readonly type: string; readonly id?: string };
  readonly requester: {
    readonly principal: { readonly id: string } | null;
    readonly actor?: { readonly id: string; readonly kind: string };
  };
  readonly tenant?: string;
  readonly detail: string;
  /** RFC 3339. */
  readonly createdAt: string;
  /** RFC 3339. */
  readonly expiresAt: string;
  readonly operation?: {
    readonly name: string;
    readonly title?: string;
    readonly risk?: OperationMeta["risk"];
    readonly effects?: OperationMeta["effects"];
  };
};

/**
 * The approval page for a prompt: a base URL the request id is appended to, or
 * a function of the prompt.
 */
export type ApprovalUrl =
  | string
  | URL
  | ((prompt: ApprovalPrompt) => string | URL);

/**
 * The prompt for a pending request. Throws a `TypeError` for a request that is
 * not pending: a resolved or expired request has nothing to approve.
 */
export function approvalPrompt(
  request: ApprovalRequest,
  options: { readonly operation?: Pick<Operation, "name" | "meta"> } = {},
): ApprovalPrompt {
  if (request.status !== "pending") {
    throw new TypeError(
      `PermDock: approvalPrompt needs a pending request, got ${request.status}`,
    );
  }
  const principal = request.subject.principal;
  const actor = request.subject.actor;
  const operation = options.operation;
  return freezeDeep(
    compact<ApprovalPrompt>({
      v: 1,
      id: request.id,
      permission: request.permission,
      scope: request.scope,
      resource: compact({
        type: request.resource.type,
        id: request.resource.id,
      }),
      requester: compact({
        principal: principal === null ? null : { id: principal.id },
        actor:
          actor === undefined ? undefined : { id: actor.id, kind: actor.kind },
      }),
      tenant: principal?.tenant,
      detail: request.detail,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      operation:
        operation === undefined
          ? undefined
          : compact({
              name: operation.name,
              title: operation.meta.title,
              risk: operation.meta.risk,
              effects: operation.meta.effects,
            }),
    }),
  );
}

/**
 * The approval page URL for `prompt`. A string or `URL` is a base the encoded
 * request id is appended to. Throws a `TypeError` for a URL that is not https.
 */
export function approvalUrlFor(
  prompt: ApprovalPrompt,
  approvalUrl: ApprovalUrl,
): string {
  let url: URL;
  try {
    if (typeof approvalUrl === "function") {
      url = new URL(approvalUrl(prompt));
    } else {
      const base = new URL(approvalUrl);
      base.pathname = `${base.pathname.replace(/\/+$/u, "")}/${encodeURIComponent(prompt.id)}`;
      url = base;
    }
  } catch {
    throw new TypeError("PermDock: approvalUrl is not a URL");
  }
  if (url.protocol !== "https:") {
    throw new TypeError("PermDock: approvalUrl must be https");
  }
  return url.href;
}
