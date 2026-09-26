import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockRevokedError,
  PermDockValidationError,
} from '../core/errors.ts';
import { problemResponse } from './problem.ts';
import { InvalidSignatureError } from './web-bot-auth.ts';

/**
 * Turns a thrown PermDock error into its Problem Details response. Returns
 * `undefined` for anything else so the framework's own error path takes over.
 */
export function mapPermDockError(error: unknown): Response | undefined {
  if (error instanceof InvalidSignatureError) {
    return error.response;
  }
  if (
    error instanceof PermDockDeniedError ||
    error instanceof PermDockApprovalRequiredError
  ) {
    return problemResponse(error.toProblemDetails(), undefined, error.decision);
  }
  if (error instanceof PermDockRevokedError) {
    return problemResponse(error.toProblemDetails(), undefined, error.decision);
  }
  if (error instanceof PermDockValidationError) {
    return problemResponse(error.toProblemDetails());
  }
  return undefined;
}
