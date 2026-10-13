import type { Subject } from "../../core/subject.ts";
import type {
  AccessReview,
  AccessReviewDecision,
  AccessReviewItem,
} from "./types.ts";

import { dateAt, type Instant } from "../../core/time.ts";
import { matchesApprovers } from "../store.ts";
import { AccessReviewError } from "./errors.ts";

export type AccessReviewVerdict = {
  readonly status: "kept" | "revoked";
  readonly by: Subject;
  readonly note?: string;
  /**
   * The `holder(permission)` reviewers `by` holds, read from `by`'s own
   * instance. Server-side input. Absent means none.
   */
  readonly permissions?: readonly string[];
};

/** Whether `by` is named as a reviewer. A link, a feed or a contact is never a reviewer. */
export function accessReviewerEligible(
  review: AccessReview,
  by: Subject,
  permissions: readonly string[] = [],
  now?: Instant,
): boolean {
  const principal = by.principal;
  if (
    principal === null ||
    principal.kind === "link" ||
    principal.kind === "feed" ||
    principal.kind === "contact"
  ) {
    return false;
  }
  return matchesApprovers(
    review.reviewers,
    by,
    review.tenant,
    dateAt(now).getTime() / 1000,
    { relations: new Set(), permissions: new Set(permissions) },
  );
}

/**
 * The decision to persist, or throws. A reviewer cannot decide a holding
 * of their own principal. `holder()` matches only through `permissions`.
 */
export function decideAccessReviewItem(
  review: AccessReview,
  item: AccessReviewItem,
  verdict: AccessReviewVerdict,
  at?: Instant,
): AccessReviewDecision {
  const now = dateAt(at);
  if (review.status !== "open") {
    throw new AccessReviewError("review-closed", "access review is closed");
  }
  if (item.review !== review.id) {
    throw new AccessReviewError(
      "item-not-found",
      "item does not belong to the review",
    );
  }
  if (item.status !== "pending") {
    throw new AccessReviewError("item-not-pending", "item is already decided");
  }
  const principal = verdict.by.principal;
  if (principal === null) {
    throw new AccessReviewError(
      "reviewer-unauthenticated",
      "reviewer must be authenticated",
    );
  }
  if (principal.id === item.principal) {
    throw new AccessReviewError(
      "reviewer-is-holder",
      "reviewer cannot decide their own access",
    );
  }
  if (
    !accessReviewerEligible(review, verdict.by, verdict.permissions ?? [], {
      epochMilliseconds: now.getTime(),
    })
  ) {
    throw new AccessReviewError(
      "reviewer-not-eligible",
      "reviewer is not eligible for this review",
    );
  }
  return {
    status: verdict.status,
    decidedBy: principal.id,
    decidedAt: now.toISOString(),
    ...(verdict.note === undefined ? {} : { note: verdict.note }),
  };
}
