import type { ProblemDetails } from "./errors.ts";

/** What a `protectAction` action resolves to; both members cross to the client. */
export type ActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: ProblemDetails };

/**
 * The server action: `approval` is the token of a granted approval request,
 * which resumes an `approval-required` decision.
 */
export type ProtectedAction<T> = (
  input: unknown,
  options?: { readonly approval?: string },
) => Promise<ActionResult<T>>;
