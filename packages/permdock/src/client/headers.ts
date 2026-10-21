import { approvalHeaderValue } from "../core/approval-header.ts";

/**
 * The `PermDock-Approval` header for a resume; a `TypeError` for a token that
 * is not an RFC 9651 sf-token.
 */
export function approvalHeaders(token: string): {
  readonly "PermDock-Approval": string;
} {
  return { "PermDock-Approval": approvalHeaderValue(token) };
}
