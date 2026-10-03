export function approvalHeaders(token: string): {
  readonly "PermDock-Approval": string;
} {
  return { "PermDock-Approval": token };
}
