import type { Approver } from "../core/approvers.ts";
import type { ApprovalStage } from "../core/policy.ts";
import type { Subject } from "../core/subject.ts";

import { flattenApprovers } from "../core/approvers.ts";
import { compact } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { matchGrantee } from "../core/grantee.ts";
import { rootMembershipId } from "../core/scopes.ts";
import { ApprovalError } from "./errors.ts";
import { pageOf } from "./page.ts";
import {
  type ApprovalCancelMeta,
  type ApprovalListFilter,
  type ApprovalListQuery,
  type ApprovalPage,
  type ApprovalRequest,
  type ApprovalStore,
  type ApprovalSignature,
  type ApprovalVerdict,
  approvalQuorum,
  approverRelationKey,
  DEFAULT_APPROVAL_TTL_MS,
  escalationOpenAt,
  stageEscalationOpenAt,
} from "./types.ts";

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

/** Facts the handler computed for the approver: relation keys held on the row, and permission keys held in the tenant. */
type ApproverFacts = {
  readonly relations: ReadonlySet<string>;
  readonly permissions: ReadonlySet<string>;
};

function matchesApprovers(
  by: Approver | readonly Approver[],
  subject: Subject,
  tenant: string | undefined,
  now: number,
  facts: ApproverFacts,
): boolean {
  const items = flattenApprovers(by);
  if (items.length === 0) {
    return false;
  }
  for (const item of items) {
    if (item.kind === "any-of") {
      if (
        !item.of.some((entry) =>
          matchesApprovers(entry, subject, tenant, now, facts),
        )
      ) {
        return false;
      }
      continue;
    }
    if (item.kind === "permission") {
      if (!facts.permissions.has(item.permission)) {
        return false;
      }
      continue;
    }
    if (item.kind === "role") {
      if (!holdsRole(subject, item.role, tenant)) {
        return false;
      }
      continue;
    }
    if (item.kind === "user") {
      if (subject.principal?.id !== item.id) {
        return false;
      }
      continue;
    }
    if (item.kind === "relation") {
      if (!facts.relations.has(approverRelationKey(item))) {
        return false;
      }
      continue;
    }
    // A grantee that narrows to rows matches no approver.
    const result = matchGrantee(item, subject, now, undefined);
    if (!result.matched || result.where !== undefined) {
      return false;
    }
  }
  return true;
}

/** Approvals recorded per stage index. */
function stageCounts(
  approvals: readonly ApprovalSignature[] | undefined,
  stages: readonly ApprovalStage[],
): readonly number[] {
  const counts = stages.map(() => 0);
  for (const item of approvals ?? []) {
    if (item.stage !== undefined && item.stage < counts.length) {
      counts[item.stage] = (counts[item.stage] ?? 0) + 1;
    }
  }
  return counts;
}

function isComplete(
  request: ApprovalRequest,
  approvals: readonly ApprovalSignature[],
): boolean {
  const stages = request.approvers?.stages;
  if (stages === undefined) {
    return approvals.length >= approvalQuorum(request);
  }
  const counts = stageCounts(approvals, stages);
  return stages.every(
    (stage, index) => (counts[index] ?? 0) >= (stage.quorum ?? 1),
  );
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

/**
 * Refuses `by` as an approver of `request`, or returns the index of the
 * stage the approval counts for (`undefined` without `stages`). Eligibility
 * is `approvers.by` or, under `stages`, the first incomplete stage
 * (`sequential`) or any incomplete stage (`all`); `approvers.escalation.to`
 * is eligible too once the request has waited `escalation.after`. A
 * principal who already approved is refused, so one person never completes
 * two stages. `relations` are the relation approvers `by` holds on the
 * request's resource (see `ApprovalVerdict.relations`).
 */
export function assertApprover(
  request: ApprovalRequest,
  by: Subject,
  requireDistinctApprover: boolean,
  now: Date = new Date(),
  relations: readonly string[] = [],
  permissions: readonly string[] = [],
): number | undefined {
  const principal = by.principal;
  if (principal === null) {
    throw new ApprovalError(
      "approver-unauthenticated",
      "approver must be authenticated",
    );
  }
  if (
    request.subject.actor !== undefined &&
    principal.id === request.subject.actor.id
  ) {
    throw new ApprovalError(
      "approver-is-actor",
      "approver is the actor of this request",
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
      "approver-is-principal",
      "approver is the principal of this request",
    );
  }
  const tenant = request.subject.principal?.tenant;
  if (tenant !== undefined && !belongsToTenant(by, tenant)) {
    throw new ApprovalError(
      "approver-not-eligible",
      "approver does not belong to the request tenant",
    );
  }
  if ((request.approvals ?? []).some((item) => item.by === principal.id)) {
    throw new ApprovalError(
      "approver-repeated",
      "approver has already approved this request",
    );
  }
  const approvers = request.approvers;
  if (approvers === undefined) {
    return undefined;
  }
  const facts: ApproverFacts = {
    relations: new Set(relations),
    permissions: new Set(permissions),
  };
  const instant = now.getTime() / 1000;
  const eligible = (target: Approver | readonly Approver[]): boolean =>
    matchesApprovers(target, by, tenant, instant, facts);
  const stageEscalated = (stage: ApprovalStage): boolean => {
    const openAt = stageEscalationOpenAt(request, stage);
    return (
      stage.escalation !== undefined &&
      openAt !== undefined &&
      now.getTime() >= openAt &&
      eligible(stage.escalation.to)
    );
  };
  const openAt = escalationOpenAt(request);
  const escalated =
    approvers.escalation !== undefined &&
    openAt !== undefined &&
    now.getTime() >= openAt &&
    eligible(approvers.escalation.to);
  const stages = approvers.stages;
  if (stages === undefined) {
    if (escalated || (approvers.by !== undefined && eligible(approvers.by))) {
      return undefined;
    }
    throw new ApprovalError(
      "approver-not-eligible",
      "approver does not hold an eligible role",
    );
  }
  const counts = stageCounts(request.approvals, stages);
  const open = stages.flatMap((stage, index) =>
    (counts[index] ?? 0) < (stage.quorum ?? 1) ? [index] : [],
  );
  const candidates = approvers.mode === "sequential" ? open.slice(0, 1) : open;
  for (const index of candidates) {
    const stage = stages[index];
    if (
      stage !== undefined &&
      (escalated || eligible(stage.by) || stageEscalated(stage))
    ) {
      return index;
    }
  }
  throw new ApprovalError(
    "approver-not-eligible",
    approvers.mode === "sequential"
      ? "approver is not eligible for the current stage"
      : "approver is not eligible for an open stage",
  );
}

function isSystemSubject(by: Subject): boolean {
  return by.actor?.kind === "system";
}

/**
 * The request after `verdict`, for a store to persist: a rejection resolves
 * it; an approval is appended to `approvals` and resolves it once there are
 * `approvers.quorum` (default 1). Throws an `ApprovalError` when the request
 * is not pending, has expired or `verdict.by` may not approve it. Stores
 * should write the result only when the stored row is still pending with the
 * same number of approvals, so two approvers racing both count.
 */
export function applyApprovalVerdict(
  request: ApprovalRequest,
  verdict: ApprovalVerdict,
  now: Date = new Date(),
): ApprovalRequest {
  const principal = verdict.by.principal;
  if (principal === null) {
    throw new ApprovalError(
      "approver-unauthenticated",
      "approver must be authenticated",
    );
  }
  if (request.status !== "pending") {
    throw new ApprovalError("approval-not-pending", "approval is not pending");
  }
  if (Date.parse(request.expiresAt) <= now.getTime()) {
    throw new ApprovalError("approval-expired", "approval has expired");
  }
  const stage =
    verdict.status === "rejected" && isSystemSubject(verdict.by)
      ? undefined
      : assertApprover(
          request,
          verdict.by,
          false,
          now,
          verdict.relations,
          verdict.permissions,
        );
  if (verdict.status === "rejected") {
    return freezeDeep(
      compact<ApprovalRequest>({
        ...request,
        status: "rejected",
        resolvedAt: now.toISOString(),
        resolvedBy: principal.id,
        note: verdict.note ?? request.note,
      }),
    );
  }
  // One approval at a time: the request stays pending until every quorum is met.
  const approvals: readonly ApprovalSignature[] = [
    ...(request.approvals ?? []),
    compact<ApprovalSignature>({
      by: principal.id,
      at: now.toISOString(),
      stage,
    }),
  ];
  if (!isComplete(request, approvals)) {
    return freezeDeep(
      compact<ApprovalRequest>({
        ...request,
        approvals,
        note: verdict.note ?? request.note,
      }),
    );
  }
  return freezeDeep(
    compact<ApprovalRequest>({
      ...request,
      status: "approved",
      approvals,
      resolvedAt: now.toISOString(),
      resolvedBy: principal.id,
      note: verdict.note ?? request.note,
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
      status: "rejected",
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
    request.status === "expired" ||
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
        throw new ApprovalError("approval-not-found", "approval was not found");
      }
      const next = applyApprovalVerdict(current, verdict, new Date());
      records.set(token, next);
      return next;
    },
    consume(token: string, now: Date = new Date()): ApprovalRequest | null {
      const current = records.get(token);
      if (
        current?.status !== "approved" ||
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
        if (request.status !== "pending" && deadline + ttl <= instant) {
          records.delete(token);
          continue;
        }
        if (request.status === "pending" && deadline <= instant) {
          records.set(
            token,
            freezeDeep(
              compact<ApprovalRequest>({ ...request, status: "expired" }),
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
        if (request.status !== "pending" || !matchesFilter(request, filter)) {
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
