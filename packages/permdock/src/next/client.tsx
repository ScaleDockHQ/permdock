"use client";

import type { ErrorInfo } from "next/error.js";
import type { ComponentType, ReactNode } from "react";

import * as nextError from "next/error.js";
import { createContext, useContext } from "react";

import type { PermDockDigest } from "../core/digest.ts";

import { parsePermDockDigest } from "../core/digest.ts";

export type PermissionBoundaryState = PermDockDigest & {
  /** Re-fetches and re-renders the boundary's children, e.g. after an approval or a role change. */
  readonly retry: () => void;
};

/** A fallback node, or a function of what was refused. */
export type PermissionBoundaryFallback =
  | ReactNode
  | ((state: PermissionBoundaryState) => ReactNode);

export type PermissionBoundaryProps = {
  /** Rendered in place of the children when one throws `PermDockDeniedError`. */
  readonly denied?: PermissionBoundaryFallback;
  /** Rendered when a child throws `PermDockApprovalRequiredError`; defaults to `denied`. */
  readonly approval?: PermissionBoundaryFallback;
};

// SAFETY: Node ESM loads next/error.js as CommonJS, where catchError is a getter only the default export (module.exports) carries; bundlers expose the named export.
const catchError: typeof nextError.catchError =
  nextError.catchError ??
  (nextError.default as unknown as typeof nextError).catchError;

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
  const fallback =
    parsed.outcome === "approval-required"
      ? (props.approval ?? props.denied)
      : props.denied;
  const state: PermissionBoundaryState = { ...parsed, retry: info.retry };
  return (
    <BoundaryContext.Provider value={state}>
      {typeof fallback === "function" ? fallback(state) : (fallback ?? null)}
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
