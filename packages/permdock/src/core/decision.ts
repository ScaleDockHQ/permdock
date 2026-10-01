import type { Grantee } from './grantee.ts';
import type { Permission } from './permissions.ts';
import type { ApprovalRequirement, Grant, HostedGrantRef } from './policy.ts';
import type { Membership, Subject } from './subject.ts';

export type DenialReason =
  | 'no-grant'
  | 'condition'
  | 'deny'
  | 'closure-error'
  | 'opaque-condition'
  | 'server-only'
  | 'anonymous'
  | 'not-delegated'
  | 'no-delegation'
  | 'insufficient-user-authentication'
  | 'not-entitled'
  | 'purpose'
  | 'reason-required'
  | 'actor-required'
  | 'limit'
  | 'limit-unavailable'
  | 'relation-depth'
  | 'relation-unavailable'
  | 'validation'
  | 'tenant-mismatch'
  | 'no-membership'
  | 'scope'
  | 'expired-membership'
  | 'stale-credentials'
  | 'unknown-role'
  | 'last-holder'
  | 'max-holders'
  | 'transfer-only'
  | 'not-assignable-by'
  | 'self-demotion'
  | 'externally-managed'
  | 'not-allowed-for-membership'
  | 'conflicting-role'
  | 'approval'
  | 'stale-approval'
  | 'pdp-denied'
  | 'pdp-unavailable'
  | 'pdp-invalid-response'
  | 'undocumented'
  | 'unsupported'
  | 'exceeds-creator'
  | 'credential-policy';

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
  /** A break-glass grant overrode a matching deny. */
  readonly breakGlass?: true;
};

/**
 * Something the caller owes alongside a granted action. `over-limit`: a soft
 * `limit` was past its count; `near-limit`: usage reached `alertAt`.
 * `notify` / `review`: a break-glass grant's declared follow-ups.
 * `justify`: the break-glass reason, carried so audit records why.
 */
export type Obligation =
  | { readonly kind: 'over-limit' | 'near-limit' | 'notify' | 'review' }
  | { readonly kind: 'justify'; readonly reason: string };

/** What is left of the `limit` that applied; `resetsAt` is Unix seconds. */
export type Quota = {
  readonly remaining: number;
  readonly resetsAt: number;
};

/**
 * The `detail` of a `limit` denial: the grant's `count`, its window in
 * seconds and when the window resets (Unix seconds).
 */
export type LimitDetail = {
  readonly count: number;
  readonly window: number;
  readonly resetsAt: number;
};

export type GrantedDecision = {
  readonly outcome: 'granted';
  readonly subject: Subject;
  readonly matched: MatchedGrant;
  readonly token: string;
  readonly obligations?: readonly Obligation[];
  readonly quota?: Quota;
  /**
   * The membership `permdock.activate` produced for the app to write: an
   * elevated, time-bound, attributed row. Set only by `activate`; a plain
   * `decide` never writes memberships.
   */
  readonly elevation?: Membership;
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
