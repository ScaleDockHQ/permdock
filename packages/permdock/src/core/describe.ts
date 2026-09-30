import type { Decision, MatchedGrant } from './decision.ts';
import type { Grantee } from './grantee.ts';
import type { Permission } from './permissions.ts';

import { flattenGrantee } from './grantee.ts';

export type DecisionDescription = {
  readonly kind:
    | 'granted'
    | 'denied'
    | 'approval'
    | 'tenant'
    | 'delegation'
    | 'server-only'
    | 'upgrade';
  readonly title: string;
  readonly detail: string;
  readonly alternatives: readonly Permission[];
  /** On `upgrade`: the plans any of which would grant the permission. */
  readonly plans?: readonly string[];
};

const TENANT_REASONS = new Set([
  'tenant-mismatch',
  'no-membership',
  'expired-membership',
  'scope',
]);

const DELEGATION_REASONS = new Set(['not-delegated', 'no-delegation']);

function labelGrantee(grantee: Grantee): string {
  switch (grantee.kind) {
    case 'role':
      return grantee.role;
    case 'plan':
      return grantee.plan;
    case 'actor':
      return grantee.actor;
    case 'authenticated':
      return 'an authenticated user';
    case 'anyone':
      return 'anyone';
    case 'relation':
      return grantee.relation;
    case 'assurance': {
      const parts: string[] = [];
      if (grantee.acr !== undefined && grantee.acr.length > 0) {
        parts.push(`acr ${grantee.acr.join('/')}`);
      }
      if (grantee.amr !== undefined && grantee.amr.length > 0) {
        parts.push(`amr ${grantee.amr.join('/')}`);
      }
      return parts.length > 0 ? parts.join(' ') : 'step-up';
    }
    default: {
      const exhaustive: never = grantee;
      return exhaustive;
    }
  }
}

/**
 * The plans named by the `not-entitled` denials of a decision, when every
 * denial is `not-entitled`; otherwise empty, since a plan alone would not grant.
 */
export function requiredPlans(decision: Decision): readonly string[] {
  if (
    decision.outcome !== 'denied' ||
    decision.denials.length === 0 ||
    decision.denials.some((denial) => denial.reason !== 'not-entitled')
  ) {
    return [];
  }
  const plans = new Set<string>();
  for (const denial of decision.denials) {
    for (const item of flattenGrantee(denial.to)) {
      if (item.kind === 'plan') {
        plans.add(item.plan);
      }
    }
  }
  return [...plans];
}

function approvalDetail(
  permission: string,
  approval: MatchedGrant['approval'],
): string {
  if (approval === undefined || approval === 'human') {
    return `${permission} requires human approval.`;
  }
  const labels = flattenGrantee(approval.by).map(labelGrantee);
  return `${permission} requires approval from ${labels.join(' and ')}.`;
}

export function describe(decision: Decision): DecisionDescription {
  if (decision.outcome === 'granted') {
    return {
      kind: 'granted',
      title: 'Granted',
      detail: `${decision.matched.permission} granted.`,
      alternatives: [],
    };
  }
  if (decision.outcome === 'approval-required') {
    return {
      kind: 'approval',
      title: 'Approval required',
      detail: approvalDetail(
        decision.grant.permission,
        decision.grant.approval,
      ),
      alternatives: [],
    };
  }
  const plans = requiredPlans(decision);
  if (plans.length > 0) {
    return {
      kind: 'upgrade',
      title: 'Upgrade required',
      detail: `${plans.join(' or ')} plan required.`,
      alternatives: decision.alternatives,
      plans,
    };
  }
  const reasons = decision.denials.map((denial) => denial.reason);
  const kind = reasons.some((reason) => TENANT_REASONS.has(reason))
    ? 'tenant'
    : reasons.some((reason) => DELEGATION_REASONS.has(reason))
      ? 'delegation'
      : reasons.includes('opaque-condition')
        ? 'server-only'
        : 'denied';
  const title =
    kind === 'tenant'
      ? 'Wrong tenant'
      : kind === 'delegation'
        ? 'Not delegated'
        : kind === 'server-only'
          ? 'Server only'
          : 'Denied';
  const detail = decision.denials.map((denial) => denial.reason).join(', ');
  return {
    kind,
    title,
    detail,
    alternatives: decision.alternatives,
  };
}
