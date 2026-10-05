import { compact } from "../core/compact.ts";
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockRevokedError,
  PermDockValidationError,
} from "../core/errors.ts";
import { decisionResponse, problemResponse } from "./problem.ts";
import { InvalidSignatureError } from "./web-bot-auth.ts";

export type ProblemFromErrorOptions = {
  readonly instance?: string;
  /** Whether the request carried credentials, which picks the `401` challenge. */
  readonly credentials?: boolean;
};

/**
 * Turns a thrown PermDock error into its Problem Details response, with the
 * status, `WWW-Authenticate` and rate-limit fields `protect` sends for the
 * same decision. Returns `undefined` for anything else so the framework's own
 * error path takes over.
 */
export function problemFromError(
  error: unknown,
  options: ProblemFromErrorOptions = {},
): Response | undefined {
  if (error instanceof InvalidSignatureError) {
    return error.response;
  }
  if (
    error instanceof PermDockDeniedError ||
    error instanceof PermDockApprovalRequiredError
  ) {
    return decisionResponse(
      error.toProblemDetails(compact({ instance: options.instance })),
      error.decision,
      compact({ scope: error.scope, credentials: options.credentials }),
    );
  }
  if (error instanceof PermDockRevokedError) {
    return problemResponse(error.toProblemDetails(), undefined, error.decision);
  }
  if (error instanceof PermDockValidationError) {
    return problemResponse(
      error.toProblemDetails(compact({ instance: options.instance })),
    );
  }
  return undefined;
}
