import type { Subject } from '../core/subject.ts';

import { compact } from '../core/compact.ts';
import { freezeDeep } from '../core/freeze.ts';
import { ApprovalError } from './errors.ts';
import {
  type ApprovalListFilter,
  type ApprovalRequest,
  type ApprovalStore,
  type ApprovalVerdict,
  DEFAULT_APPROVAL_TTL_MS,
} from './types.ts';

function tenantOf(request: ApprovalRequest): string | undefined {
  return request.subject.principal?.tenant;
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
  if (
    requireDistinctApprover &&
    request.subject.principal !== null &&
    principal.id === request.subject.principal.id
  ) {
    throw new ApprovalError(
      'approver-is-principal',
      'approver is the principal of this request',
    );
  }
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
  assertApprover(request, verdict.by, false);
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

export type MemoryApprovalStore = ApprovalStore & {
  readonly ttl: number;
};

export function memoryApprovalStore(
  options: { readonly ttl?: number } = {},
): MemoryApprovalStore {
  const ttl = options.ttl ?? DEFAULT_APPROVAL_TTL_MS;
  const records = new Map<string, ApprovalRequest>();

  const store: MemoryApprovalStore = {
    ttl,
    create(request: ApprovalRequest): void {
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
    list(filter: ApprovalListFilter): ApprovalRequest[] {
      const out: ApprovalRequest[] = [];
      for (const request of records.values()) {
        if (matchesFilter(request, filter)) {
          out.push(request);
        }
      }
      return out;
    },
    expire(now: Date = new Date()): number {
      let count = 0;
      const instant = now.getTime();
      for (const [token, request] of records) {
        if (
          request.status === 'pending' &&
          Date.parse(request.expiresAt) <= instant
        ) {
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
  };
  return store;
}
