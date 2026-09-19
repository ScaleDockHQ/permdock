export type ApprovalErrorCode =
  | 'approval-not-found'
  | 'approval-not-pending'
  | 'approval-expired'
  | 'approver-unauthenticated'
  | 'approver-is-actor'
  | 'approver-is-principal'
  | 'approver-not-eligible';

export class ApprovalError extends Error {
  public override readonly name = 'ApprovalError' as const;
  public readonly code: ApprovalErrorCode;

  public constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function isApprovalError(value: unknown): value is ApprovalError {
  return value instanceof ApprovalError;
}
