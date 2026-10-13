export type AccessReviewErrorCode =
  | "review-not-found"
  | "review-closed"
  | "item-not-found"
  | "item-not-pending"
  | "reviewer-unauthenticated"
  | "reviewer-not-eligible"
  | "reviewer-is-holder"
  | "not-revoked"
  | "already-applied";

export class AccessReviewError extends Error {
  public override readonly name = "AccessReviewError" as const;
  public readonly code: AccessReviewErrorCode;

  public constructor(code: AccessReviewErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const CODES: ReadonlySet<string> = new Set<AccessReviewErrorCode>([
  "review-not-found",
  "review-closed",
  "item-not-found",
  "item-not-pending",
  "reviewer-unauthenticated",
  "reviewer-not-eligible",
  "reviewer-is-holder",
  "not-revoked",
  "already-applied",
]);

export function isAccessReviewError(
  value: unknown,
): value is AccessReviewError {
  if (!(value instanceof Error) || value.name !== "AccessReviewError") {
    return false;
  }
  const code: unknown = Reflect.get(value, "code");
  return typeof code === "string" && CODES.has(code);
}
