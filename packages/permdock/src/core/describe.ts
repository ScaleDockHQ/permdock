import type { Decision } from './decision.ts';
import type { Permission } from './permissions.ts';

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
      detail: `${decision.grant.permission} requires human approval.`,
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
