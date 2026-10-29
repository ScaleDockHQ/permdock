import type { MetaValue } from "./app-data.ts";
import type { Grantee } from "./grantee.ts";
import type { Permission } from "./permission-types.ts";
import type {
  ApprovalRequirement,
  Grant,
  GrantMeta,
  HostedGrantRef,
  WireValidity,
} from "./policy-types.ts";
import type { Membership, Subject } from "./subject.ts";

export type DenialReason =
  | "no-grant"
  | "condition"
  | "deny"
  | "inactive-grant"
  | "closure-error"
  | "opaque-condition"
  | "server-only"
  | "anonymous"
  | "not-delegated"
  | "no-delegation"
  | "agent-tool-not-delegated"
  | "insufficient-user-authentication"
  | "not-entitled"
  | "purpose"
  | "reason-required"
  | "actor-required"
  | "limit"
  | "limit-unavailable"
  | "relation-depth"
  | "relation-unavailable"
  | "validation"
  | "tenant-mismatch"
  | "no-membership"
  | "no-tenant"
  | "scope"
  | "expired-membership"
  | "stale-credentials"
  | "unknown-role"
  | "last-holder"
  | "max-holders"
  | "transfer-only"
  | "not-assignable-by"
  | "self-demotion"
  | "externally-managed"
  | "not-allowed-for-membership"
  | "conflicting-role"
  | "approval"
  | "stale-approval"
  | "pdp-denied"
  | "pdp-unavailable"
  | "pdp-invalid-response"
  | "undocumented"
  | "unsupported"
  | "exceeds-creator"
  | "credential-policy";

/**
 * The `detail` each denial reason carries, where PermDock sets a structured
 * one.
 */
export type DenialDetails = {
  readonly limit: LimitDetail;
  /** The window the inactive allow applies in. */
  readonly "inactive-grant": WireValidity;
  /** The matching deny's declared `name`. */
  readonly deny: { readonly name?: string };
};

/**
 * Why a candidate grant did not apply. `Denial<"limit">` types `detail` for a
 * reason in `DenialDetails`; any other reason's detail is `unknown`.
 */
export type Denial<R extends DenialReason = DenialReason> = {
  readonly role: string | null;
  readonly reason: R;
  readonly detail?: [R] extends [keyof DenialDetails]
    ? DenialDetails[R]
    : unknown;
  readonly to?: Grantee | readonly Grantee[];
};

export type MatchedGrant = {
  readonly role: string | null;
  readonly permission: string;
  /** The grant's declared `name`, when it has one. */
  readonly name?: string;
  /** The grant's declared `meta`, when it has one; PermDock never reads it. */
  readonly meta?: GrantMeta;
  readonly to?: Grantee | readonly Grantee[];
  readonly where?: Grant["where"];
  readonly check?: Grant["check"];
  readonly approval?: "human" | ApprovalRequirement;
  readonly provider?: string;
  /**
   * The hosted policy document fingerprint and grant id, when a hosted grant
   * matched.
   */
  readonly hosted?: HostedGrantRef;
  /** A break-glass grant overrode a matching deny. */
  readonly breakGlass?: true;
};

/**
 * Something the caller owes alongside a granted action. `over-limit`: a soft
 * `limit` was past its count; `near-limit`: usage reached `alertAt`. `notify` /
 * `review`: a break-glass grant's declared follow-ups. `justify`: the
 * break-glass reason, carried so audit records why. `app`: a follow-up the
 * application declared on the grant (`allow(p, { obligations })`); PermDock
 * carries it and never acts on it.
 */
export type Obligation =
  | { readonly kind: "over-limit" | "near-limit" | "notify" | "review" }
  | { readonly kind: "justify"; readonly reason: string }
  | AppObligation;

/** An obligation the application declares on an allow and handles itself. */
export type AppObligation = {
  readonly kind: "app";
  /** Lower case letters, digits, `_` and `-`, starting with a letter. */
  readonly name: string;
  readonly detail?: MetaValue;
};

/** What is left of the `limit` that applied; `resetsAt` is RFC 3339. */
export type Quota = { readonly remaining: number; readonly resetsAt: string };

/**
 * The `detail` of a `limit` denial: the grant's `count`, its `per` window in
 * seconds and when the window resets (RFC 3339).
 */
export type LimitDetail = {
  readonly count: number;
  readonly per: number;
  readonly resetsAt: string;
};

/**
 * Why a candidate grant for the permission was passed over before its condition
 * ran: `via-only` (the subject holds no membership of its kind), `purpose` (no
 * asserted purpose it lists), `field` (its `fields` do not cover the requested
 * field), `grantee` (its `to` did not match and added no denial), `role` (a
 * role it names is not held), `validity` (a deny outside its `validFrom` /
 * `validUntil`; an inactive allow adds an `inactive-grant` denial instead),
 * `break-glass-inactive` (a break-glass grant with no asserted purpose).
 */
export type TraceSkipReason =
  | "via-only"
  | "purpose"
  | "field"
  | "grantee"
  | "role"
  | "validity"
  | "unknown-level"
  | "break-glass-inactive";

export type TraceSkip = {
  readonly role: string | null;
  readonly permission: string;
  readonly effect: "allow" | "deny";
  readonly why: TraceSkipReason;
  /**
   * The level a custom role names that its resource does not declare, for
   * `unknown-level`.
   */
  readonly level?: string;
};

/**
 * What `explain` saw: how many candidate grants it examined before the outcome,
 * which allows matched (including the ones a deny overrode), which denies
 * matched, and which grants it passed over. `denies[0]` is the deny that
 * produced a `deny` outcome, or the deny a break-glass grant lifted. Pure local
 * computation; never on a decision event.
 */
export type Trace = {
  readonly evaluated: number;
  readonly allows: readonly MatchedGrant[];
  readonly denies: readonly MatchedGrant[];
  readonly skipped: readonly TraceSkip[];
};

export type GrantedDecision = {
  readonly outcome: "granted";
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
  /** Present only with `explain: true`. */
  readonly trace?: Trace;
};

export type DeniedDecision = {
  readonly outcome: "denied";
  /**
   * The key of the permission that was checked. Absent on a denial for a check
   * that named no declared permission.
   */
  readonly permission?: string;
  readonly denials: readonly Denial[];
  readonly alternatives: readonly Permission[];
  /** Present only with `explain: true`. */
  readonly trace?: Trace;
};

export type ApprovalRequiredDecision = {
  readonly outcome: "approval-required";
  readonly grant: MatchedGrant;
  readonly reason: "human";
  readonly token: string;
  /**
   * The `fingerprint` the call passed, bound into `token`; the request it opens
   * records it, and a resume under another fingerprint is refused.
   */
  readonly fingerprint?: string;
  /** Present only with `explain: true`. */
  readonly trace?: Trace;
};

/** A decision from `explain`: the same union, with the trace always present. */
export type ExplainedDecision = Decision & { readonly trace: Trace };

export type Decision =
  | GrantedDecision
  | DeniedDecision
  | ApprovalRequiredDecision;

/** The denial for a check that failed or named no declared permission. */
export const NO_GRANT: DeniedDecision = Object.freeze({
  outcome: "denied",
  denials: Object.freeze([Object.freeze({ role: null, reason: "no-grant" })]),
  alternatives: Object.freeze([]),
});

/** The denial for a check whose row loader threw: it fails closed. */
export const LOAD_FAILED: DeniedDecision = Object.freeze({
  outcome: "denied",
  denials: Object.freeze([Object.freeze({ role: null, reason: "validation" })]),
  alternatives: Object.freeze([]),
});
