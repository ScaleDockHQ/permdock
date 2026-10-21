import type { Approver } from "../../core/approvers.ts";

export type AccessReviewStatus = "open" | "closed";

export type AccessReviewItemStatus = "pending" | "kept" | "revoked";

/**
 * Access review v1: who holds `permissions` in one tenant, and who may confirm
 * or revoke each holding. PermDock records the reviewer's decision and never
 * changes the role or membership itself.
 */
export type AccessReview = {
  readonly v: 1;
  readonly id: string;
  readonly tenant: string;
  readonly permissions: readonly string[];
  readonly reviewers: Approver | readonly Approver[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly dueAt: string;
  readonly status: AccessReviewStatus;
  /** `false` when the population can omit a holder, such as a global role. */
  readonly complete: boolean;
};

/**
 * One holding in a review. `via` names the roles the population attributed it
 * to.
 */
export type AccessReviewItem = {
  readonly v: 1;
  readonly id: string;
  readonly review: string;
  readonly principal: string;
  readonly permission: string;
  readonly via: readonly string[];
  readonly status: AccessReviewItemStatus;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly note?: string;
  /** Set by the application after it revoked the holding at its source. */
  readonly appliedAt?: string;
};

export type AccessReviewItemQuery = {
  readonly review: string;
  readonly status?: AccessReviewItemStatus;
  readonly limit?: number;
  readonly cursor?: string;
};

export type AccessReviewItemPage = {
  readonly items: readonly AccessReviewItem[];
  readonly next?: string;
};

export type AccessReviewDecision = {
  readonly status: "kept" | "revoked";
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly note?: string;
};

export type AccessReviewStore = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  create: (
    review: AccessReview,
    items: readonly AccessReviewItem[],
  ) => Promise<void> | void;
  get: (id: string) => Promise<AccessReview | null> | AccessReview | null;
  items: (
    query: AccessReviewItemQuery,
  ) => Promise<AccessReviewItemPage> | AccessReviewItemPage;
  decide: (
    reviewId: string,
    itemId: string,
    decision: AccessReviewDecision,
  ) => Promise<AccessReviewItem> | AccessReviewItem;
  markApplied: (
    reviewId: string,
    itemId: string,
    at: string,
  ) => Promise<AccessReviewItem> | AccessReviewItem;
  close: (id: string) => Promise<AccessReview> | AccessReview;
};
