import type { Decision } from '../core/decision.ts';
import type { ProblemDetails } from '../core/errors.ts';
import type { Permission } from '../core/permissions.ts';

import { compact } from '../core/compact.ts';

const PROBLEM_BASE = 'https://permdock.dev/problems';

function quoted(value: string): string {
  return `"${value.replaceAll(/["\\]/gu, '')}"`;
}

export function wwwAuthenticate(
  decision: Decision,
  permission: Permission | undefined,
): string | undefined {
  if (decision.outcome === 'approval-required') {
    return undefined;
  }
  if (decision.outcome === 'granted') {
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
