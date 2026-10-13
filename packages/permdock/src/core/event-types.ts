import type { CredentialKind } from "./credential.ts";
import type { Obligation } from "./decision.ts";
import type { Grantee } from "./grantee.ts";
import type { GrantMeta, HostedGrantRef } from "./policy-types.ts";
import type { Membership } from "./subject.ts";
import type { WireDelegation } from "./wire-delegation.ts";
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
  /** When the membership lapses, an RFC 3339 instant. */
  readonly expiresAt?: string;
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
  /** When the key expires, an RFC 3339 instant. */
  readonly expiresAt?: string;
  readonly by?: { readonly id: string; readonly kind: string };
  readonly sample?: number;
};

export type SinkEvent =
  | DecisionEvent
  | DirectoryEvent
  | MembershipEvent
  | CredentialEvent
  | AccessEvent
  | DeliveryEvent;

/** A delivery channel: an email, a chat message or an outbound webhook. */
export type DeliveryChannel = "email" | "chat" | "webhook";

/** What an email is for; only `notification` mail carries `List-Unsubscribe`. */
export type EmailCategory =
  | "transactional"
  | "notification"
  | "security"
  | "approval";

/**
 * Why a delivery failed. `denied` and `unlinked` are the router's refusals of
 * a recipient; the rest come from a transport or a provider webhook.
 */
export type DeliveryFailureCause =
  | "denied"
  | "unlinked"
  | "no-transport"
  | "no-message"
  | "invalid-recipient"
  | "invalid-message"
  | "rate-limited"
  | "quota-exceeded"
  | "unauthorized"
  | "unavailable"
  | "suppressed"
  | "rejected";

/**
 * One recipient's delivery: `sent` when a transport accepted it, then
 * `delivered`, `bounced` or `complained` from the provider, or `failed`.
 * It carries no address, only the principal the router checked.
 */
export type DeliveryEvent = {
  readonly type: "delivery";
  readonly at: string;
  readonly source: string;
  readonly operation:
    | "sent"
    | "delivered"
    | "bounced"
    | "complained"
    | "failed";
  readonly channel: DeliveryChannel;
  /** The delivery's id and this recipient's key, sent as the `Idempotency-Key`. */
  readonly delivery: { readonly id: string; readonly key: string };
  /** The checked principal, or `trusted` for an address the server loaded itself. */
  readonly recipient?: {
    readonly principal?: { readonly id: string };
    readonly trusted?: true;
  };
  /** The permission the recipient was checked for. */
  readonly permission?: string;
  readonly tenant?: string;
  readonly category?: EmailCategory;
  /** The approval request a prompt was delivered for. */
  readonly approval?: string;
  /** The transport or provider, and its message id. */
  readonly provider?: { readonly name: string; readonly id?: string };
  /** Set on `failed` only. */
  readonly cause?: DeliveryFailureCause;
  /** Set on `failed` only: whether a retry with the same key may succeed. */
  readonly retryable?: boolean;
  /** The denial reason when `cause` is `denied`. */
  readonly reason?: string;
};

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
  /** When the session lapses, an RFC 3339 instant. */
  readonly expiresAt?: string;
  /** The tenant principal that consented. */
  readonly grantedBy?: string;
  readonly reason?: string;
  readonly actor?: { readonly id: string; readonly kind: string };
};

export type DecisionEvent = {
  readonly type: "decision";
  /** An RFC 3339 instant. */
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
    /** OAuth `scope` and RFC 9396 `authorization_details`, as every wire form carries a delegation. */
    readonly delegation?: WireDelegation;
    /** The API key the subject came from. */
    readonly credential?: {
      readonly id: string;
      readonly kind: CredentialKind;
    };
  };
  readonly tenant?: string;
  /** The membership that answered, with `expiresAt` as an RFC 3339 instant. */
  readonly membership?: Omit<Membership, "expiresAt"> & {
    readonly expiresAt?: string;
  };
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
  /** The call that produced the decision. */
  readonly call:
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
  /** Set on an approval lifecycle event (`com.permdock.approval.<phase>`). */
  readonly phase?: "requested" | "resolved" | "expired" | "cancelled";
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
