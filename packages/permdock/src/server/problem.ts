import type { Decision } from '../core/decision.ts';
import type { ApprovalHint, ProblemDetails } from '../core/errors.ts';
import type { Grantee } from '../core/grantee.ts';
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

export type BearerChallenge = {
  readonly error:
    | 'invalid_token'
    | 'insufficient_scope'
    | 'insufficient_user_authentication';
  /** Every scope the operation needs, not the held set plus the missing one. */
  readonly scopes?: readonly string[];
  /** The RFC 9728 Protected Resource Metadata URL. */
  readonly resourceMetadata?: string;
  /** RFC 9470 step-up parameters. */
  readonly acrValues?: readonly string[];
  readonly maxAge?: number;
};

/** An RFC 6750 `WWW-Authenticate: Bearer` value. */
export function bearerChallenge(challenge: BearerChallenge): string {
  const parts = [`error=${quoted(challenge.error)}`];
  if (challenge.scopes !== undefined && challenge.scopes.length > 0) {
    parts.push(`scope=${quoted([...new Set(challenge.scopes)].join(' '))}`);
  }
  if (challenge.acrValues !== undefined && challenge.acrValues.length > 0) {
    parts.push(`acr_values=${quoted(challenge.acrValues.join(' '))}`);
  }
  if (challenge.maxAge !== undefined) {
    parts.push(`max_age=${quoted(String(challenge.maxAge))}`);
  }
  if (challenge.resourceMetadata !== undefined) {
    parts.push(`resource_metadata=${quoted(challenge.resourceMetadata)}`);
  }
  return `Bearer ${parts.join(', ')}`;
}

/** The RFC 9728 well-known metadata URL for a resource identifier. */
export function protectedResourceMetadataUrl(resource: URL): string {
  const path = resource.pathname === '/' ? '' : resource.pathname;
  return `${resource.origin}/.well-known/oauth-protected-resource${path}`;
}

/** The `acr` values and the tightest `maxAge` the failing assurance grants ask for. */
export function stepUpOf(decision: Decision): {
  readonly acrValues?: readonly string[];
  readonly maxAge?: number;
} {
  if (decision.outcome !== 'denied') {
    return {};
  }
  const acr = new Set<string>();
  let maxAge: number | undefined;
  for (const denial of decision.denials) {
    if (denial.reason !== 'insufficient-user-authentication') {
      continue;
    }
    const grantees =
      denial.to === undefined
        ? []
        : Array.isArray(denial.to)
          ? denial.to
          : [denial.to];
    for (const grantee of grantees as readonly Grantee[]) {
      if (grantee.kind !== 'assurance') {
        continue;
      }
      for (const value of grantee.acr ?? []) {
        acr.add(value);
      }
      if (grantee.maxAge !== undefined) {
        maxAge =
          maxAge === undefined
            ? grantee.maxAge
            : Math.min(maxAge, grantee.maxAge);
      }
    }
  }
  return compact({
    acrValues: acr.size === 0 ? undefined : [...acr],
    maxAge,
  });
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
    return bearerChallenge({ error: 'insufficient_user_authentication' });
  }
  if (reasons.has('anonymous')) {
    return bearerChallenge({ error: 'invalid_token' });
  }
  if (reasons.has('not-delegated') || reasons.has('no-delegation')) {
    return bearerChallenge(
      compact<BearerChallenge>({
        error: 'insufficient_scope',
        scopes: permission === undefined ? undefined : [permission.scope],
      }),
    );
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
  options: {
    readonly instance?: string;
    readonly approval?: ApprovalHint;
  } = {},
): Response {
  const base = PROBLEM_BASE;
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
    const approval =
      options.approval === undefined ||
      (options.approval.at === undefined && options.approval.hint === undefined)
        ? undefined
        : compact<ApprovalHint>({
            at: options.approval.at,
            hint: options.approval.hint,
          });
    return problemResponse(
      compact<ProblemDetails>({
        ...details,
        type: `${base}/approval-required`,
        approval,
      }),
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
