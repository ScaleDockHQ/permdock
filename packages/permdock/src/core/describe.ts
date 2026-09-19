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
    | 'server-only';
  readonly title: string;
  readonly detail: string;
  readonly alternatives: readonly Permission[];
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
