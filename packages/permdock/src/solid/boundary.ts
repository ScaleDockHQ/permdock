import {
  createComponent,
  createContext,
  ErrorBoundary,
  useContext,
  type JSX,
} from "solid-js";

import type { PermissionBoundaryState } from "../client/boundary.ts";
import type { PermissionBoundaryProps, SolidChild } from "./types.ts";

import { boundaryDigest, boundaryFallback } from "../client/boundary.ts";

const BoundaryContext = createContext<PermissionBoundaryState | null>(null);

type BoundaryProviderProps = Parameters<typeof BoundaryContext.Provider>[0];

type ErrorBoundaryProps = Parameters<typeof ErrorBoundary>[0];

/**
 * Catches `PermDockDeniedError` and `PermDockApprovalRequiredError` thrown
 * below it and renders `denied`, or `approval` for an approval request
 * (default `denied`), with the refused permission and `retry()`. Any other
 * error goes to the next `ErrorBoundary` up.
 */
export function PermissionBoundary(
  props: PermissionBoundaryProps,
): JSX.Element {
  // SAFETY: Solid renders whatever children it is given; the prop is `unknown` so any JSX child fits.
  return createComponent(ErrorBoundary, {
    fallback: (error: unknown, reset: () => void): JSX.Element => {
      const digest = boundaryDigest(error);
      if (digest === null) {
        throw error;
      }
      const state: PermissionBoundaryState = { ...digest, retry: reset };
      // SAFETY: Solid renders whatever children it is given; the prop is `unknown` so any child fits.
      return createComponent(BoundaryContext.Provider, {
        value: state,
        get children(): SolidChild {
          const chosen = boundaryFallback(digest, props);
          return typeof chosen === "function"
            ? chosen(state)
            : (chosen ?? null);
        },
      } as BoundaryProviderProps) as JSX.Element;
    },
    get children(): unknown {
      return props.children;
    },
  } as ErrorBoundaryProps);
}

/** Inside a `PermissionBoundary` fallback: what was refused and `retry()`. */
export function usePermissionBoundary(): PermissionBoundaryState | null {
  return useContext(BoundaryContext);
}
