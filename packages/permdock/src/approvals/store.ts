import type { Grantee } from '../core/grantee.ts';
import type { Subject } from '../core/subject.ts';

import { compact } from '../core/compact.ts';
import { freezeDeep } from '../core/freeze.ts';
import { flattenGrantee, matchGrantee } from '../core/grantee.ts';
import { rootMembershipId } from '../core/scopes.ts';
import { ApprovalError } from './errors.ts';
import { pageOf } from './page.ts';
import {
  type ApprovalCancelMeta,
  type ApprovalListFilter,
  type ApprovalListQuery,
  type ApprovalPage,
  type ApprovalRequest,
  type ApprovalStore,
  type ApprovalVerdict,
  DEFAULT_APPROVAL_TTL_MS,
} from './types.ts';

function tenantOf(request: ApprovalRequest): string | undefined {
  return request.subject.principal?.tenant;
}

function membershipTenants(subject: Subject): readonly string[] {
  const principal = subject.principal;
  if (principal === null) {
    return [];
  }
  const tenants = new Set<string>();
  if (principal.tenant !== undefined) {
    tenants.add(principal.tenant);
  }
  for (const membership of principal.memberships ?? []) {
    const tenant = rootMembershipId(membership);
    if (tenant !== undefined) {
      tenants.add(tenant);
    }
  }
  return [...tenants];
}

function belongsToTenant(subject: Subject, tenant: string): boolean {
  return membershipTenants(subject).includes(tenant);
}

function holdsRole(subject: Subject, role: string, tenant?: string): boolean {
  const principal = subject.principal;
  if (principal === null) {
    return false;
  }
  if ((principal.roles ?? []).includes(role)) {
    return true;
  }
  for (const membership of principal.memberships ?? []) {
    if (!membership.roles.includes(role)) {
      continue;
    }
    // No cascade: only a membership of the tenant itself makes an approver there.
    if (tenant !== undefined && rootMembershipId(membership) !== tenant) {
      continue;
    }
    return true;
  }
  return false;
}

function matchesApprovers(
  by: Grantee | readonly Grantee[],
  subject: Subject,
  tenant: string | undefined,
  now: number,
): boolean {
  const items = flattenGrantee(by);
  if (items.length === 0) {
    return false;
  }
  for (const item of items) {
    if (item.kind === 'role') {
      if (!holdsRole(subject, item.role, tenant)) {
        return false;
      }
      continue;
    }
    // A relation needs a row and a relation reader the store does not have, so
    // it matches no approver; so does any grantee that narrows to rows.
    if (item.kind === 'relation') {
      return false;
    }
    const result = matchGrantee(item, subject, now, undefined);
    if (!result.matched || result.where !== undefined) {
      return false;
    }
  }
  return true;
}

function matchesFilter(
  request: ApprovalRequest,
  filter: ApprovalListFilter,
): boolean {
  if (filter.status !== undefined && request.status !== filter.status) {
    return false;
  }
  if (
    filter.principalId !== undefined &&
    request.subject.principal?.id !== filter.principalId
  ) {
    return false;
  }
  if (
    filter.actorId !== undefined &&
    request.subject.actor?.id !== filter.actorId
  ) {
    return false;
  }
  if (filter.tenant !== undefined && tenantOf(request) !== filter.tenant) {
    return false;
  }
  if (
    filter.session !== undefined &&
    request.subject.session !== filter.session
  ) {
    return false;
  }
  return true;
}

export function assertApprover(
  request: ApprovalRequest,
  by: Subject,
  requireDistinctApprover: boolean,
): void {
  const principal = by.principal;
  if (principal === null) {
    throw new ApprovalError(
      'approver-unauthenticated',
      'approver must be authenticated',
    );
  }
  if (
    request.subject.actor !== undefined &&
    principal.id === request.subject.actor.id
  ) {
    throw new ApprovalError(
      'approver-is-actor',
      'approver is the actor of this request',
    );
  }
  const distinct =
    requireDistinctApprover || request.approvers?.distinct !== false;
  if (
    distinct &&
    request.subject.principal !== null &&
    principal.id === request.subject.principal.id
  ) {
    throw new ApprovalError(
      'approver-is-principal',
      'approver is the principal of this request',
    );
  }
  const tenant = request.subject.principal?.tenant;
  if (tenant !== undefined && !belongsToTenant(by, tenant)) {
    throw new ApprovalError(
      'approver-not-eligible',
      'approver does not belong to the request tenant',
    );
  }
  if (request.approvers === undefined) {
    return;
  }
  if (!matchesApprovers(request.approvers.by, by, tenant, Date.now() / 1000)) {
    throw new ApprovalError(
      'approver-not-eligible',
      'approver does not hold an eligible role',
    );
  }
}

function isSystemSubject(by: Subject): boolean {
  return by.actor?.kind === 'system';
}

function applyVerdict(
  request: ApprovalRequest,
  verdict: ApprovalVerdict,
  now: Date,
): ApprovalRequest {
  const principal = verdict.by.principal;
  if (principal === null) {
    throw new ApprovalError(
      'approver-unauthenticated',
      'approver must be authenticated',
    );
  }
  if (request.status !== 'pending') {
    throw new ApprovalError('approval-not-pending', 'approval is not pending');
  }
  if (Date.parse(request.expiresAt) <= now.getTime()) {
    throw new ApprovalError('approval-expired', 'approval has expired');
  }
  if (!(verdict.status === 'rejected' && isSystemSubject(verdict.by))) {
    assertApprover(request, verdict.by, false);
  }
  return freezeDeep(
    compact<ApprovalRequest>({
      ...request,
      status: verdict.status,
      resolvedAt: now.toISOString(),
      resolvedBy: principal.id,
      note: verdict.note,
    }),
  );
}

function rejectPending(
  request: ApprovalRequest,
  meta: ApprovalCancelMeta,
  now: Date,
): ApprovalRequest {
  return freezeDeep(
    compact<ApprovalRequest>({
      ...request,
      status: 'rejected',
      resolvedAt: now.toISOString(),
      resolvedBy: `system:${meta.by}`,
      note: meta.note,
    }),
  );
}

export type MemoryApprovalStore = ApprovalStore & {
  readonly ttl: number;
};

/** A request a new ask may replace: expired, or past its deadline. */
function isStale(request: ApprovalRequest, now: Date): boolean {
  return (
    request.status === 'expired' ||
    Date.parse(request.expiresAt) <= now.getTime()
  );
}

export function memoryApprovalStore(
  options: { readonly ttl?: number } = {},
): MemoryApprovalStore {
  const ttl = options.ttl ?? DEFAULT_APPROVAL_TTL_MS;
  const records = new Map<string, ApprovalRequest>();

  const store: MemoryApprovalStore = {
    ttl,
    create(request: ApprovalRequest): void {
      const current = records.get(request.token);
      if (current !== undefined && !isStale(current, new Date())) {
        return;
      }
      records.set(request.token, freezeDeep(request));
    },
    get(token: string): ApprovalRequest | null {
      return records.get(token) ?? null;
    },
    resolve(token: string, verdict: ApprovalVerdict): ApprovalRequest {
      const current = records.get(token);
      if (current === undefined) {
        throw new ApprovalError('approval-not-found', 'approval was not found');
      }
      const next = applyVerdict(current, verdict, new Date());
      records.set(token, next);
      return next;
    },
    consume(token: string, now: Date = new Date()): ApprovalRequest | null {
      const current = records.get(token);
      if (
        current?.status !== 'approved' ||
        current.consumedAt !== undefined ||
        Date.parse(current.expiresAt) <= now.getTime()
      ) {
        return null;
      }
      const next = freezeDeep({ ...current, consumedAt: now.toISOString() });
      records.set(token, next);
      return next;
    },
    list(query: ApprovalListQuery): ApprovalPage {
      const matching: ApprovalRequest[] = [];
      for (const request of records.values()) {
        if (matchesFilter(request, query)) {
          matching.push(request);
        }
      }
      return pageOf(matching, query);
    },
    expire(now: Date = new Date()): number {
      let count = 0;
      const instant = now.getTime();
      for (const [token, request] of records) {
        const deadline = Date.parse(request.expiresAt);
        if (request.status !== 'pending' && deadline + ttl <= instant) {
          records.delete(token);
          continue;
        }
        if (request.status === 'pending' && deadline <= instant) {
          records.set(
            token,
            freezeDeep(
              compact<ApprovalRequest>({ ...request, status: 'expired' }),
            ),
          );
          count += 1;
        }
      }
      return count;
    },
    cancel(filter: ApprovalListFilter, meta: ApprovalCancelMeta): number {
      const now = new Date();
      let count = 0;
      for (const [token, request] of records) {
        if (request.status !== 'pending' || !matchesFilter(request, filter)) {
          continue;
        }
        records.set(token, rejectPending(request, meta, now));
        count += 1;
      }
      return count;
    },
  };
  return store;
}
