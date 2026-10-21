import type { ProblemDetails } from "./errors.ts";

import { compact } from "./compact.ts";
import { PROBLEM_BASE } from "./validation-error.ts";

/**
 * The Problem Details types PermDock defines (RFC 9457 section 4). Every other
 * status answers with `about:blank` and its RFC 9110 reason phrase.
 */
export const PROBLEM_TYPES = [
  "denied",
  "approval-required",
  "validation",
  "step-up-required",
  "not-entitled",
  "rate-limited",
  "limit-unavailable",
  "invalid-signature",
  "approver-not-eligible",
] as const;

export type ProblemType = (typeof PROBLEM_TYPES)[number];

/** The `type` URI of a PermDock problem type. */
export function problemType(type: ProblemType): string {
  return `${PROBLEM_BASE}/${type}`;
}

/** RFC 9110 section 15 reason phrases for the statuses PermDock answers with. */
const REASON_PHRASES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  409: "Conflict",
  412: "Precondition Failed",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  428: "Precondition Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** An `about:blank` problem: the `title` is the status's reason phrase. */
export function statusProblem(
  status: number,
  detail: string,
  extra: Omit<
    Partial<ProblemDetails>,
    "type" | "title" | "status" | "detail"
  > = {},
): ProblemDetails {
  return compact<ProblemDetails>({
    type: "about:blank",
    title: REASON_PHRASES[status] ?? "Error",
    status,
    detail,
    ...extra,
  });
}
