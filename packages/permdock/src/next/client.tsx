"use client";

import type { ErrorInfo } from "next/error";
import type { ComponentType, ReactNode } from "react";

import { catchError } from "next/error";
import { createContext, useContext } from "react";

import type { PermDockDigest } from "../core/digest.ts";

import { parsePermDockDigest } from "../core/digest.ts";

export type PermissionBoundaryState = PermDockDigest & {
  /** Re-fetches and re-renders the boundary's children, e.g. after an approval or a role change. */
  readonly retry: () => void;
};

export type PermissionBoundaryProps = {
  /** Rendered in place of the children when one throws `PermDockDeniedError`. */
  readonly denied?: ReactNode;
  /** Rendered when a child throws `PermDockApprovalRequiredError`; defaults to `denied`. */
  readonly approval?: ReactNode;
};

const BoundaryContext = createContext<PermissionBoundaryState | null>(null);

function PermissionFallback(
  props: PermissionBoundaryProps,
  info: ErrorInfo,
): ReactNode {
  // SAFETY: an optional read of the digest Next.js adds to errors; parsePermDockDigest validates it.
  const parsed = parsePermDockDigest(
    (info.error as Error & { readonly digest?: unknown }).digest,
  );
  if (parsed === null) {
    // Not a PermDock error: let the next boundary up handle it.
    throw info.error;
  }
  const node =
    parsed.outcome === "approval-required"
      ? (props.approval ?? props.denied)
      : props.denied;
  return (
    <BoundaryContext.Provider value={{ ...parsed, retry: info.retry }}>
      {node ?? null}
    </BoundaryContext.Provider>
  );
}

/**
 * A component-level boundary for PermDock errors thrown below it, in a Server
 * Component or a Client Component. Other errors, `forbidden()`, `notFound()`
 * and `redirect()` pass through.
 */
export const PermissionBoundary: ComponentType<
  PermissionBoundaryProps & { readonly children?: ReactNode }
> = catchError(PermissionFallback);

/** Inside a `PermissionBoundary` fallback: what was refused, and `retry()`. */
export function usePermissionBoundary(): PermissionBoundaryState | null {
  return useContext(BoundaryContext);
}
