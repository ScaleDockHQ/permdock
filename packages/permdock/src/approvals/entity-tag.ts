import type { ApprovalRequest } from "./types.ts";

import { canonicalJson } from "../core/canonical-json.ts";
import { sha256Digest } from "../core/sha256.ts";

/** An approval as the approvals API shows it: never the resume `token`. */
export type ApprovalView = Omit<ApprovalRequest, "token">;

/** The request without its resume `token`; every other field stays. */
export function approvalView(request: ApprovalRequest): ApprovalView {
  const { token: _token, ...view } = request;
  return view;
}

/**
 * A strong RFC 9110 entity tag: the quoted `sha-256:` digest of
 * `approvalView(request)` as RFC 8785 JSON. A field outside
 * `ApprovalRequest` changes the tag, so hash the stored request as is.
 */
export function approvalEntityTag(request: ApprovalRequest): string {
  return `"${sha256Digest(canonicalJson(approvalView(request)))}"`;
}
