import type { Subject } from "../core/subject.ts";
import type { ApprovalRequest } from "./types.ts";

/**
 * Lists who may approve a request, for `fallback: 'confirm'`. Answers the
 * subject ids of every eligible approver, or `null` when it cannot tell; `null`
 * and a throw keep the request's principal refused.
 */
export type ApproverDirectory = {
  readonly name?: string;
  approversFor: (
    request: ApprovalRequest,
  ) => readonly string[] | null | Promise<readonly string[] | null>;
};

/**
 * The number of eligible approvers other than `by` and the request's principal,
 * or `undefined` when the request has no `fallback: 'confirm'`, there is no
 * directory, or it cannot answer.
 */
export async function countOtherApprovers(
  request: ApprovalRequest,
  by: Subject,
  directory: ApproverDirectory | undefined,
): Promise<number | undefined> {
  if (directory === undefined || request.approvers?.fallback !== "confirm") {
    return undefined;
  }
  let ids: readonly string[] | null;
  try {
    ids = await directory.approversFor(request);
  } catch {
    return undefined;
  }
  if (ids === null) {
    return undefined;
  }
  const excluded = new Set<string>();
  for (const subject of [by, request.subject]) {
    if (subject.principal !== null) {
      excluded.add(subject.principal.id);
    }
  }
  if (request.subject.actor !== undefined) {
    excluded.add(request.subject.actor.id);
  }
  return new Set(ids.filter((id) => !excluded.has(id))).size;
}
