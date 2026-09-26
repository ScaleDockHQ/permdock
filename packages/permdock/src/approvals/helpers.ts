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
  type ApprovalApprovers,
  type ApprovalCancelMeta,
  type ApprovalInspectResult,
  type ApprovalListFilter,
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
    session: subject.session,
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
  const approval = decision.grant.approval;
  const approvers: ApprovalApprovers | undefined =
    approval === undefined || approval === 'human'
      ? undefined
      : compact<ApprovalApprovers>({
          by: approval.by,
          distinct: approval.distinct,
        });
  const request = freezeDeep(
    compact<ApprovalRequest>({
      v: 2,
      token: decision.token,
      permission: leaf.key,
      scope: leaf.scope,
      resource: meta.resource ?? {
        type: leaf.resource,
      },
      subject: summariseSubject(meta.subject),
      membership: meta.membership,
      approvers,
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
  if (request.consumedAt !== undefined) {
    return { ok: false, detail: 'approval-consumed' };
  }
  if (
    request.status === 'expired' ||
    Date.parse(request.expiresAt) <= now.getTime()
  ) {
    return { ok: false, detail: 'approval-expired' };
  }
  return { ok: true, request };
}

/** Inspects `token` and, when it is approved, consumes it so it resumes once. */
export async function consumeApproval(
  store: ApprovalStore,
  token: string,
  now: Date = new Date(),
): Promise<ApprovalInspectResult> {
  const inspected = await inspectApproval(store, token, now);
  if (!inspected.ok) {
    return inspected;
  }
  if (typeof store.consume !== 'function') {
    return { ok: false, detail: 'approval-not-found' };
  }
  const consumed = await store.consume(token, now);
  if (consumed === null) {
    return { ok: false, detail: 'approval-consumed' };
  }
  return { ok: true, request: consumed };
}

function approvalDenied(
  detail: string,
): Extract<Decision, { readonly outcome: 'denied' }> {
  return {
    outcome: 'denied',
    denials: [{ role: null, reason: 'approval', detail }],
    alternatives: [],
  };
}

/**
 * Applies a resume token to a decision. The token only matters when the
 * decision is `approval-required` and the token is the one this call was
 * issued; otherwise a new approval is requested. A matching token is consumed
 * unless `consume` is `false`, so an approval resumes exactly one call.
 */
export async function resumeDecision(input: {
  readonly decision: Decision;
  readonly permission:
    | Permission
    | {
        readonly key: string;
        readonly scope: string;
        readonly resource: string;
      };
  readonly subject: Subject;
  readonly store: ApprovalStore | undefined;
  readonly resource: { readonly type: string; readonly id?: string };
  readonly adapter: string;
  readonly token: string | undefined;
  /** `false` for checks that do not run the action, such as the decision endpoint. */
  readonly consume?: boolean;
  readonly now?: Date;
}): Promise<Decision> {
  const { decision, store, token } = input;
  if (decision.outcome !== 'approval-required') {
    return decision;
  }
  if (token === undefined || token !== decision.token) {
    if (store !== undefined) {
      await requestApproval(
        store,
        decision,
        compact({
          permission: input.permission,
          resource: input.resource,
          subject: input.subject,
          adapter: input.adapter,
        }),
      );
    }
    return decision;
  }
  if (store === undefined) {
    return approvalDenied('approval-not-found');
  }
  let inspected: ApprovalInspectResult;
  try {
    inspected = await inspectApproval(store, token, input.now);
    if (inspected.ok) {
      const { request } = inspected;
      if (
        request.permission !== input.permission.key ||
        (request.resource.id !== undefined &&
          request.resource.id !== input.resource.id)
      ) {
        return approvalDenied('approval-mismatch');
      }
      if (input.consume !== false) {
        inspected = await consumeApproval(store, token, input.now);
      }
    }
  } catch {
    return approvalDenied('approval-not-found');
  }
  if (!inspected.ok) {
    return approvalDenied(inspected.detail);
  }
  const principal = input.subject.principal;
  if (principal === null) {
    return approvalDenied('approval-mismatch');
  }
  return {
    outcome: 'granted',
    subject: { ...input.subject, principal },
    matched: decision.grant,
    token: decision.token,
  };
}

const SYSTEM_KIND = 'system';

export async function cancelApprovals(
  store: ApprovalStore,
  filter: ApprovalListFilter,
  meta: ApprovalCancelMeta,
): Promise<number> {
  if (store.cancel !== undefined) {
    return store.cancel(filter, meta);
  }
  const pending = await store.list({ ...filter, status: 'pending' });
  const by: Subject = {
    principal: { id: `system:${meta.by}`, kind: 'service', roles: [] },
    actor: { id: `system:${meta.by}`, kind: SYSTEM_KIND },
    context: {},
  };
  const outcomes = await Promise.all(
    pending.map(async (request): Promise<boolean> => {
      try {
        await store.resolve(
          request.token,
          compact<ApprovalVerdict>({
            status: 'rejected',
            by,
            note: meta.note,
          }),
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
  return outcomes.filter(Boolean).length;
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
