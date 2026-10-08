import type { PermDockDigest } from "../core/digest.ts";

import { parsePermDockDigest } from "../core/digest.ts";

export type PermissionBoundaryState = PermDockDigest & {
  /** Renders the boundary's children again, e.g. after an approval or a role change. */
  readonly retry: () => void;
};

/** The digest of a PermDock error (`PermDockDeniedError`, `PermDockApprovalRequiredError`); `null` for any other error. */
export function boundaryDigest(error: unknown): PermDockDigest | null {
  if (error === null || typeof error !== "object" || !("digest" in error)) {
    return null;
  }
  return parsePermDockDigest(error.digest);
}
