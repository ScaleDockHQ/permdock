import type { Permission } from './permissions.ts';
import type { Grant } from './policy.ts';
import type { Subject } from './subject.ts';

export type DenialReason =
  | 'no-grant'
  | 'condition'
  | 'deny'
  | 'closure-error'
  | 'opaque-condition'
  | 'anonymous'
  | 'not-delegated'
  | 'no-delegation'
  | 'insufficient-user-authentication'
  | 'limit'
  | 'limit-unavailable'
  | 'validation'
  | 'tenant-mismatch'
  | 'no-membership'
  | 'scope'
  | 'expired-membership'
  | 'unknown-role'
  | 'approval'
  | 'pdp-denied'
  | 'pdp-unavailable'
  | 'pdp-invalid-response';

export type Denial = {
  readonly role: string | null;
  readonly reason: DenialReason;
  readonly detail?: unknown;
};

export type MatchedGrant = {
  readonly role: string;
  readonly permission: string;
  readonly where?: Grant['where'];
  readonly check?: Grant['check'];
  readonly approval?: 'human';
  readonly provider?: string;
};

export type GrantedDecision = {
  readonly outcome: 'granted';
  readonly subject: Subject & {
    readonly principal: NonNullable<Subject['principal']>;
  };
  readonly matched: MatchedGrant;
  readonly token: string;
};

export type DeniedDecision = {
  readonly outcome: 'denied';
  readonly denials: readonly Denial[];
  readonly alternatives: readonly Permission[];
};

export type ApprovalRequiredDecision = {
  readonly outcome: 'approval-required';
  readonly grant: MatchedGrant;
  readonly reason: 'human';
  readonly token: string;
};

export type Decision =
  | GrantedDecision
  | DeniedDecision
  | ApprovalRequiredDecision;
