import type { Grantee } from './grantee.ts';
import type { Permission } from './permissions.ts';
import type { ApprovalRequirement, Grant, HostedGrantRef } from './policy.ts';
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
  | 'pdp-invalid-response'
  | 'undocumented'
  | 'unsupported';

export type Denial = {
  readonly role: string | null;
  readonly reason: DenialReason;
  readonly detail?: unknown;
  readonly to?: Grantee | readonly Grantee[];
};

export type MatchedGrant = {
  readonly role: string | null;
  readonly permission: string;
  readonly to?: Grantee | readonly Grantee[];
  readonly where?: Grant['where'];
  readonly check?: Grant['check'];
  readonly approval?: 'human' | ApprovalRequirement;
  readonly provider?: string;
  /** The hosted policy document fingerprint and grant id, when a hosted grant matched. */
  readonly hosted?: HostedGrantRef;
};

export type GrantedDecision = {
  readonly outcome: 'granted';
  readonly subject: Subject;
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
