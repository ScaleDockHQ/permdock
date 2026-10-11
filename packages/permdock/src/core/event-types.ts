import type { CredentialKind } from "./credential.ts";
import type { Obligation } from "./decision.ts";
import type { Grantee } from "./grantee.ts";
import type { GrantMeta, HostedGrantRef } from "./policy-types.ts";
import type { Membership } from "./subject.ts";
import type { WireDenial } from "./wire-denial.ts";

export type DirectoryEvent = {
  readonly type: "directory";
  readonly at: string;
  readonly source: "scim";
  readonly operation: "create" | "replace" | "patch" | "delete";
  readonly tenant: string;
  readonly resource: {
    readonly type: "User" | "Group";
    readonly id: string;
  };
  readonly credential:
    | { readonly kind: "token" }
    | { readonly kind: "jwt"; readonly iss?: string };
  readonly active?: boolean;
};

export type MembershipEvent = {
  readonly type: "membership";
  readonly at: string;
  readonly source: string;
  readonly operation: "added" | "removed" | "changed";
  readonly principal: { readonly id: string };
  /** A declared scope name, or the `tenant` / `team` alias; absent for a global role change. */
  readonly scope?: string;
  /** The scope instance; present exactly when `scope` is. */
  readonly id?: string;
  /** The id of every ancestor scope, keyed by scope name. */
  readonly within?: Readonly<Record<string, string>>;
  readonly via?: string;
  /** When the membership lapses, in seconds since the epoch. */
  readonly expiresAt?: number;
  readonly roles: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
  };
  readonly by?: { readonly id: string; readonly kind: string };
};

/**
 * An API key's lifecycle: `created`, `rotated` and `revoked` from the
 * application or a credential store, `used` from `subjectFromApiKey`. A
 * `used` event carries `sample`, the fraction of uses reported.
 */
export type CredentialEvent = {
  readonly type: "credential";
  readonly at: string;
  readonly source: string;
  readonly operation: "created" | "used" | "rotated" | "revoked";
  readonly credential: { readonly id: string; readonly kind: CredentialKind };
  readonly principal: { readonly id: string };
  readonly tenant?: string;
  readonly expiresAt?: number;
  readonly by?: { readonly id: string; readonly kind: string };
  readonly sample?: number;
};

export type SinkEvent =
  | DecisionEvent
  | DirectoryEvent
  | MembershipEvent
  | CredentialEvent
  | AccessEvent;

/**
 * A support-access session lifecycle event: a tenant consented to vendor
 * support (`started`), the session lapsed (`ended`), or the tenant pulled
 * consent early (`revoked`). It never decides; it records what happened for
 * audit and revocation.
 */
export type AccessEvent = {
  readonly type: "access";
  readonly at: string;
  readonly source: string;
  readonly operation: "started" | "ended" | "revoked";
  readonly tenant: string;
  readonly principal: { readonly id: string };
  /** The membership kind the session runs under (`support`). */
  readonly via: string;
  readonly roles: readonly string[];
  readonly member?: { readonly group: string };
  readonly expiresAt?: number;
  /** The tenant principal that consented. */
  readonly grantedBy?: string;
  readonly reason?: string;
  readonly actor?: { readonly id: string; readonly kind: string };
};

export type DecisionEvent = {
  readonly type: "decision";
  readonly at: string;
  readonly outcome: "granted" | "denied" | "approval-required";
  readonly permission: string;
  readonly scope: string;
  readonly resource: { readonly type: string; readonly id?: string };
  readonly subject: {
    readonly principal: {
      readonly id: string;
      readonly roles: readonly string[];
      readonly tenant?: string;
    } | null;
    readonly actor?: { readonly id: string; readonly kind: string };
    readonly delegation?: {
      readonly scopes?: readonly string[];
      readonly authorizationDetails?: readonly unknown[];
    };
    /** The API key the subject came from. */
    readonly credential?: {
      readonly id: string;
      readonly kind: CredentialKind;
    };
  };
  readonly tenant?: string;
  readonly membership?: Membership;
  readonly via?: string | null;
  readonly matched?: {
    readonly role: string | null;
    readonly permission: string;
    /** The grant's declared `name`. */
    readonly name?: string;
    /** The grant's declared `meta`; PermDock never reads it. */
    readonly meta?: GrantMeta;
    readonly to?: Grantee | readonly Grantee[];
    readonly hosted?: HostedGrantRef;
    readonly breakGlass?: true;
  };
  /** What a granted decision owes, as on `GrantedDecision.obligations`. */
  readonly obligations?: readonly Obligation[];
  /** Purposes of use the caller asserted (`context.purpose`); present when any was. */
  readonly purpose?: readonly string[];
  /** The justification the caller supplied (`context.reason`); present when set. */
  readonly reason?: string;
  readonly denials?: readonly WireDenial[];
  readonly alternatives?: readonly string[];
  readonly token?: string;
  readonly trusted: boolean;
  readonly source:
    | "can"
    | "decide"
    | "assert"
    | "filter"
    | "endpoint"
    | "adapter"
    | "approval"
    | "simulate"
    | "explain";
  readonly adapter?: string;
  readonly phase?: "requested" | "resolved";
  readonly counts?: {
    readonly granted: number;
    readonly denied: number;
    readonly approvalRequired: number;
  };
};

export type AuthEvent = {
  readonly reason:
    | "invalid-token"
    | "schema"
    | "unknown-role"
    | "groups-overflow"
    | "source-threw";
  readonly cause?: string;
  readonly source: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly typ?: string;
  readonly issuer?: string;
  readonly requestId?: string;
};
