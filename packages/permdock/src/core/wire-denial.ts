import type {
  ApprovalRequiredDecision,
  DeniedDecision,
  Denial,
  DenialReason,
  GrantedDecision,
} from './decision.ts';
import type { Grantee } from './grantee.ts';

import { compact } from './compact.ts';

/**
 * A denial as it leaves the process: in a decision event, a Problem Details
 * body, an MCP or WebMCP refusal and the decision endpoint. `detail` is a
 * JSON value (a string, or `LimitDetail` on `limit`); what a closure threw
 * and a validation error stay in process.
 */
export type WireDenial = {
  readonly role: string | null;
  readonly reason: DenialReason;
  readonly to?: Grantee | readonly Grantee[];
  readonly detail?: unknown;
};

/** A `Decision` whose denials are `WireDenial`s, as the decision endpoint sends it. */
export type WireDecision =
  | GrantedDecision
  | ApprovalRequiredDecision
  | (Omit<DeniedDecision, 'denials'> & {
      readonly denials: readonly WireDenial[];
    });

const IN_PROCESS = new Set<DenialReason>(['closure-error', 'validation']);

function jsonDetail(value: unknown): unknown {
  if (value === undefined || value === null || value instanceof Error) {
    return undefined;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'object') {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

export function wireDenial(denial: Denial): WireDenial {
  return compact<WireDenial>({
    role: denial.role,
    reason: denial.reason,
    to: denial.to,
    detail: IN_PROCESS.has(denial.reason)
      ? undefined
      : jsonDetail(denial.detail),
  });
}

export function wireDenials(denials: readonly Denial[]): readonly WireDenial[] {
  return denials.map(wireDenial);
}
