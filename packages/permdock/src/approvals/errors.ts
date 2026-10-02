export type ApprovalErrorCode =
  | 'approval-not-found'
  | 'approval-not-pending'
  | 'approval-expired'
  | 'approver-unauthenticated'
  | 'approver-is-actor'
  | 'approver-is-principal'
  | 'approver-not-eligible'
  | 'approver-repeated';

export class ApprovalError extends Error {
  public override readonly name = 'ApprovalError' as const;
  public readonly code: ApprovalErrorCode;

  public constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const CODES: ReadonlySet<string> = new Set<ApprovalErrorCode>([
  'approval-not-found',
  'approval-not-pending',
  'approval-expired',
  'approver-unauthenticated',
  'approver-is-actor',
  'approver-is-principal',
  'approver-not-eligible',
  'approver-repeated',
]);

/** Matches by `name` and `code`, so an error from another copy of the module still maps. */
export function isApprovalError(value: unknown): value is ApprovalError {
  if (!(value instanceof Error) || value.name !== 'ApprovalError') {
    return false;
  }
  const code: unknown = Reflect.get(value, 'code');
  return typeof code === 'string' && CODES.has(code);
}
