import type { Decision } from '../core/decision.ts';
import type { ProblemDetails } from '../core/errors.ts';
import type { Permission } from '../core/permissions.ts';
import type { Subject } from '../core/subject.ts';

import { compact } from '../core/compact.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
  approvalMessage,
  deniedMessage,
} from '../core/errors.ts';

export const PROBLEM_BASE = 'https://permdock.dev/problems';

function quoted(value: string): string {
  return `"${value.replaceAll(/["\\]/gu, '')}"`;
}

export function wwwAuthenticate(
  decision: Decision,
  permission: Permission | undefined,
): string | undefined {
  if (decision.outcome !== 'denied') {
    return undefined;
  }
  const reasons = new Set(decision.denials.map((denial) => denial.reason));
  if (reasons.has('insufficient-user-authentication')) {
    return 'Bearer error="insufficient_user_authentication"';
  }
  if (reasons.has('anonymous')) {
    return 'Bearer error="invalid_token"';
  }
  if (reasons.has('not-delegated') || reasons.has('no-delegation')) {
    const scope = permission?.scope;
    if (scope === undefined) {
      return 'Bearer error="insufficient_scope"';
    }
    return `Bearer error="insufficient_scope", scope=${quoted(scope)}`;
  }
  return undefined;
}

export function problemResponse(
  details: ProblemDetails,
  permission?: Permission,
  decision?: Decision,
): Response {
  const headers = new Headers({
    'content-type': 'application/problem+json',
  });
  if (decision !== undefined) {
    const challenge = wwwAuthenticate(decision, permission);
    if (challenge !== undefined) {
      headers.set('WWW-Authenticate', challenge);
    }
  }
  return new Response(JSON.stringify(details), {
    status: details.status,
    headers,
  });
}

export function validationProblem(detail: string): Response {
  return problemResponse(
    compact<ProblemDetails>({
      type: `${PROBLEM_BASE}/validation`,
      title: 'Invalid request',
      status: 400,
      detail,
    }),
  );
}

function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  const id =
    data !== null && typeof data === 'object' && 'id' in data
      ? (data as { readonly id?: unknown }).id
      : undefined;
  return compact({
    type: permission.resource,
    id:
      typeof id === 'string' || typeof id === 'number' ? String(id) : undefined,
  });
}

export function problemFromDecision(
  decision: Decision,
  permission: Permission,
  subject: Subject,
  options: { readonly instance?: string; readonly base?: string } = {},
): Response {
  const base = options.base ?? PROBLEM_BASE;
  if (decision.outcome === 'granted') {
    return new Response(null, { status: 204 });
  }
  if (decision.outcome === 'approval-required') {
    const error = new PermDockApprovalRequiredError({
      decision,
      permission: permission.key,
      scope: permission.scope,
      resource: resourceRef(permission, undefined),
      message: approvalMessage(permission.key, decision.reason, decision.token),
    });
    const details = error.toProblemDetails(
      compact({ instance: options.instance }),
    );
    return problemResponse(
      { ...details, type: `${base}/approval-required` },
      permission,
      decision,
    );
  }
  const reasons = new Set(decision.denials.map((denial) => denial.reason));
  if (
    decision.denials.some(
      (denial) => denial.detail instanceof PermDockValidationError,
    )
  ) {
    const validation = decision.denials[0]?.detail;
    if (validation instanceof PermDockValidationError) {
      return problemResponse(
        validation.toProblemDetails(),
        permission,
        decision,
      );
    }
  }
  const error = new PermDockDeniedError({
    decision,
    permission: permission.key,
    scope: permission.scope,
    resource: resourceRef(permission, undefined),
    subject,
    message: deniedMessage(
      permission.key,
      subject.principal?.id,
      decision.denials,
      decision.alternatives.map((leaf) => leaf.key),
    ),
  });
  const details = error.toProblemDetails(
    compact({ instance: options.instance }),
  );
  let status = details.status;
  let type = `${base}/denied`;
  if (reasons.has('anonymous')) {
    status = 401;
    type = `${base}/unauthenticated`;
  } else if (reasons.has('insufficient-user-authentication')) {
    status = 401;
    type = `${base}/step-up-required`;
  }
  return problemResponse({ ...details, status, type }, permission, decision);
}
