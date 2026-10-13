import type {
  AccessReview,
  AccessReviewDecision,
  AccessReviewItem,
  AccessReviewItemPage,
  AccessReviewItemQuery,
  AccessReviewStore,
} from "./types.ts";

import { freezeDeep } from "../../core/freeze.ts";
import { approvalPageSize, decodeApprovalCursor } from "../page.ts";
import { AccessReviewError } from "./errors.ts";

function position(item: AccessReviewItem): readonly [string, string] {
  return [item.principal, item.id];
}

function compare(
  left: readonly [string, string],
  right: readonly [string, string],
): number {
  if (left[0] !== right[0]) {
    return left[0] < right[0] ? -1 : 1;
  }
  if (left[1] === right[1]) {
    return 0;
  }
  return left[1] < right[1] ? -1 : 1;
}

/** Pages items in `(principal, id)` order with the approval cursor codec. */
export function pageAccessReviewItems(
  matching: readonly AccessReviewItem[],
  query: AccessReviewItemQuery,
): AccessReviewItemPage {
  const after =
    query.cursor === undefined ? undefined : decodeApprovalCursor(query.cursor);
  if (after === null) {
    return { items: [] };
  }
  const sorted = matching
    .filter((item) => after === undefined || compare(position(item), after) > 0)
    .toSorted((left, right) => compare(position(left), position(right)));
  const size = approvalPageSize(query.limit);
  const items = sorted.slice(0, size);
  const last = items.at(-1);
  return sorted.length > size && last !== undefined
    ? { items, next: JSON.stringify(position(last)) }
    : { items };
}

type Recorded = {
  readonly review: AccessReview;
  readonly items: Map<string, AccessReviewItem>;
};

function requireOpen(review: AccessReview): void {
  if (review.status !== "open") {
    throw new AccessReviewError("review-closed", "access review is closed");
  }
}

export type MemoryAccessReviews = AccessReviewStore & {
  readonly reviews: () => readonly AccessReview[];
};

/** In-process access reviews for tests and single-replica apps. */
export function memoryAccessReviews(): MemoryAccessReviews {
  const records = new Map<string, Recorded>();
  const load = (id: string): Recorded => {
    const recorded = records.get(id);
    if (recorded === undefined) {
      throw new AccessReviewError(
        "review-not-found",
        "access review was not found",
      );
    }
    return recorded;
  };
  return Object.freeze({
    reviews: (): readonly AccessReview[] =>
      [...records.values()].map((recorded) => recorded.review),
    create(review: AccessReview, items: readonly AccessReviewItem[]): void {
      if (records.has(review.id)) {
        return;
      }
      const byId = new Map<string, AccessReviewItem>();
      for (const item of items) {
        if (item.review !== review.id) {
          throw new AccessReviewError(
            "item-not-found",
            "item does not belong to the review",
          );
        }
        byId.set(item.id, item);
      }
      records.set(review.id, { review: freezeDeep(review), items: byId });
    },
    get(id: string): AccessReview | null {
      return records.get(id)?.review ?? null;
    },
    items(query: AccessReviewItemQuery): AccessReviewItemPage {
      const recorded = records.get(query.review);
      if (recorded === undefined) {
        return { items: [] };
      }
      const matching = [...recorded.items.values()].filter(
        (item) => query.status === undefined || item.status === query.status,
      );
      return pageAccessReviewItems(matching, query);
    },
    decide(
      reviewId: string,
      itemId: string,
      decision: AccessReviewDecision,
    ): AccessReviewItem {
      const recorded = load(reviewId);
      requireOpen(recorded.review);
      const current = recorded.items.get(itemId);
      if (current === undefined) {
        throw new AccessReviewError("item-not-found", "item was not found");
      }
      if (current.status !== "pending") {
        throw new AccessReviewError(
          "item-not-pending",
          "item is already decided",
        );
      }
      const next = freezeDeep<AccessReviewItem>({
        ...current,
        status: decision.status,
        decidedBy: decision.decidedBy,
        decidedAt: decision.decidedAt,
        ...(decision.note === undefined ? {} : { note: decision.note }),
      });
      recorded.items.set(itemId, next);
      return next;
    },
    markApplied(
      reviewId: string,
      itemId: string,
      at: string,
    ): AccessReviewItem {
      const recorded = load(reviewId);
      const current = recorded.items.get(itemId);
      if (current === undefined) {
        throw new AccessReviewError("item-not-found", "item was not found");
      }
      if (current.status !== "revoked") {
        throw new AccessReviewError(
          "not-revoked",
          "only a revoked holding can be marked applied",
        );
      }
      if (current.appliedAt !== undefined) {
        throw new AccessReviewError(
          "already-applied",
          "holding is already marked applied",
        );
      }
      const next = freezeDeep<AccessReviewItem>({ ...current, appliedAt: at });
      recorded.items.set(itemId, next);
      return next;
    },
    close(id: string): AccessReview {
      const recorded = load(id);
      requireOpen(recorded.review);
      const next = freezeDeep<AccessReview>({
        ...recorded.review,
        status: "closed",
      });
      records.set(id, { review: next, items: recorded.items });
      return next;
    },
  });
}
