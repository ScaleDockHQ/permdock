import type { Decision } from '../core/decision.ts';
import type { Permission } from '../core/permissions.ts';
import type { Membership, Subject } from '../core/subject.ts';

import { compact } from '../core/compact.ts';
import { describe } from '../core/describe.ts';
import { freezeDeep } from '../core/freeze.ts';
import { ApprovalError } from './errors.ts';
import { assertApprover } from './store.ts';
import {
  APPROVAL_HEADER,
  type ApprovalInspectResult,
  type ApprovalRequest,
  type ApprovalStore,
  type ApprovalVerdict,
  DEFAULT_APPROVAL_TTL_MS,
} from './types.ts';

function permissionMeta(
  permission:
    | Permission
    | {
        readonly key: string;
        readonly scope: string;
        readonly resource: string;
      },
): { readonly key: string; readonly scope: string; readonly resource: string } {
  return {
    key: permission.key,
    scope: permission.scope,
    resource: permission.resource,
  };
}

export function summariseSubject(subject: Subject): ApprovalRequest['subject'] {
  const principal = subject.principal;
  return compact<ApprovalRequest['subject']>({
    principal:
      principal === null
        ? null
        : compact<{
            readonly id: string;
            readonly roles: readonly string[];
            readonly tenant?: string;
          }>({
            id: principal.id,
            roles: principal.roles ?? [],
            tenant: principal.tenant,
          }),
    actor:
      subject.actor === undefined
        ? undefined
        : { id: subject.actor.id, kind: subject.actor.kind },
    delegation:
      subject.delegation === undefined
        ? undefined
        : compact<NonNullable<ApprovalRequest['subject']['delegation']>>({
            scopes: subject.delegation.scopes,
            authorizationDetails: subject.delegation.authorizationDetails,
          }),
  });
}

export async function requestApproval(
  store: ApprovalStore,
  decision: Extract<Decision, { readonly outcome: 'approval-required' }>,
  meta: {
    readonly permission:
      | Permission
      | {
          readonly key: string;
          readonly scope: string;
          readonly resource: string;
        };
    readonly resource?: { readonly type: string; readonly id?: string };
    readonly subject: Subject;
    readonly membership?: Membership;
    readonly adapter?: string;
    readonly ttl?: number;
    readonly now?: Date;
    readonly detail?: string;
  },
): Promise<ApprovalRequest> {
  const now = meta.now ?? new Date();
  const ttl = meta.ttl ?? DEFAULT_APPROVAL_TTL_MS;
  const leaf = permissionMeta(meta.permission);
  const request = freezeDeep(
    compact<ApprovalRequest>({
      v: 1,
      token: decision.token,
      permission: leaf.key,
      scope: leaf.scope,
      resource: meta.resource ?? {
        type: leaf.resource,
      },
      subject: summariseSubject(meta.subject),
      membership: meta.membership,
      detail: meta.detail ?? describe(decision).detail,
      adapter: meta.adapter,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      status: 'pending',
    }),
  );
  await store.create(request);
  return request;
}

export async function resolveApproval(
  store: ApprovalStore,
  token: string,
  verdict: ApprovalVerdict,
  options: { readonly requireDistinctApprover?: boolean } = {},
): Promise<ApprovalRequest> {
  const current = await store.get(token);
  if (current === null) {
    throw new ApprovalError('approval-not-found', 'approval was not found');
  }
  assertApprover(current, verdict.by, options.requireDistinctApprover === true);
  return store.resolve(token, verdict);
}

export async function inspectApproval(
  store: ApprovalStore,
  token: string,
  now: Date = new Date(),
): Promise<ApprovalInspectResult> {
  await store.expire(now);
  const request = await store.get(token);
  if (request === null) {
    return { ok: false, detail: 'approval-not-found' };
  }
  if (request.status === 'pending') {
    return { ok: false, detail: 'approval-pending' };
  }
  if (request.status === 'rejected') {
    return { ok: false, detail: 'approval-rejected' };
  }
  if (
    request.status === 'expired' ||
    Date.parse(request.expiresAt) <= now.getTime()
  ) {
    return { ok: false, detail: 'approval-expired' };
  }
  return { ok: true, request };
}

export function readApprovalHeader(
  headers: Headers | { readonly get: (name: string) => string | null },
): string | undefined {
  const value = headers.get(APPROVAL_HEADER);
  if (value === null || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

export function resumeFromHeader(
  store: ApprovalStore,
  headers: Headers | { readonly get: (name: string) => string | null },
  now?: Date,
): Promise<ApprovalInspectResult> {
  const token = readApprovalHeader(headers);
  if (token === undefined) {
    return Promise.resolve({ ok: false, detail: 'approval-not-found' });
  }
  return inspectApproval(store, token, now);
}
