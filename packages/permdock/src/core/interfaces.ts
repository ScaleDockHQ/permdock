import type { Condition } from "../conditions/ast.ts";
import type {
  Credential,
  CredentialKind,
  CredentialPolicy,
} from "./credential.ts";
import type { Decision } from "./decision.ts";
import type { Grantee } from "./grantee.ts";
import type { Permission } from "./permissions.ts";
import type {
  ApprovalRequirement,
  GrantValidity,
  HostedGrantRef,
} from "./policy.ts";
import type {
  CustomRole,
  JsonWebKeyLike,
  Membership,
  Principal,
  Subject,
} from "./subject.ts";
import type { Plan, Role } from "./vocabulary.ts";
import type { WireDenial } from "./wire-denial.ts";

export type DecisionProvider = {
  readonly name: string;
  handles(permission: Permission): boolean;
  decide(request: {
    readonly permission: Permission;
    readonly data?: unknown;
    readonly subject: Subject;
    readonly local: Decision;
  }): Promise<Decision>;
  /**
   * Ids of the resources of `permission.resource` the subject may act on.
   * `null` means the provider could not answer and every row is denied;
   * `undefined` means it cannot list, and each row is decided on its own.
   */
  permitted?(request: {
    readonly permission: Permission;
    readonly subject: Subject;
  }): Promise<readonly string[] | null | undefined>;
};

export type RoleSource = {
  rolesFor(tenant: string): CustomRole[] | Promise<CustomRole[]>;
  assignable?(tenant: string): string[] | Promise<string[]>;
  /** Platform custom roles (`scope: 'global'`), read once per signed-in subject. A role here with a tenant is ignored. */
  globalRoles?(): CustomRole[] | Promise<CustomRole[]>;
};

/** One member of a scope instance, as `MembershipSource.list` returns it. */
export type MemberEntry = {
  readonly principal: { readonly id: string };
  readonly membership: Membership;
};

export type MembershipSource = {
  membershipsFor(
    principal: { readonly id: string; readonly kind?: string },
    options: { readonly tenant?: string },
  ): Membership[] | Promise<Membership[]>;
  /** Every membership held in one scope instance, for member lists and access reviews. */
  list?(query: {
    readonly scope: string;
    readonly id: string;
  }): MemberEntry[] | Promise<MemberEntry[]>;
  /**
   * The principal's current authorization version, bumped on every membership
   * change. A token whose `authzVersion` is behind it is stale for the
   * policy's `fresh` permissions.
   */
  version?(principal: {
    readonly id: string;
  }): number | undefined | Promise<number | undefined>;
  /**
   * Keep the memberships the verified token carries and read this source only
   * when the token says they were truncated (`claimsFirst`).
   */
  readonly claimsFirst?: boolean;
};

/** An object's parent chain, as `RelationSource.ancestors` returns it. */
export type RelationChain = {
  /** Whether the object itself is restricted: nothing above it reaches it. */
  readonly restricted?: boolean;
  /** Ancestors nearest first, at most `depth`; a restricted one ends the walk after itself. */
  readonly ancestors: readonly {
    readonly id: string;
    readonly restricted?: boolean;
  }[];
  /** The chain goes on above the last entry. */
  readonly truncated?: boolean;
};

type HolderPeriod = {
  /** Seconds since the epoch; before it the relation does not hold yet. */
  readonly startsAt?: number;
  /** Seconds since the epoch; from it on the relation no longer holds. */
  readonly expiresAt?: number;
};

/** A group holding a relation on an object: whoever holds `relation` on the group's instance holds it too. */
export type RelationGroup = {
  readonly resource: string;
  readonly id: string;
  readonly relation: string;
};

/**
 * One holder of a relation on an object, as `RelationSource.related` returns
 * it: a principal, or a group (an edge row whose `groups` column names one).
 */
export type RelationHolder = HolderPeriod &
  (
    | { readonly principal: { readonly id: string } }
    | { readonly group: RelationGroup }
  );

/**
 * The object graph: parent chains, links and who holds a relation on an
 * object. A source answers facts and never decides; a thrown or rejected
 * call, or a Promise the instance has not loaded, denies with
 * `relation-unavailable`.
 */
export type RelationSource = {
  /**
   * With `through: 'parent'`, the parent chain; with a link name, the one
   * instance that link points to (`depth` is then 1).
   */
  ancestors(query: {
    readonly resource: string;
    readonly id: string;
    readonly through: string;
    readonly depth: number;
  }): RelationChain | Promise<RelationChain>;
  related(query: {
    readonly resource: string;
    readonly id: string;
    readonly relation: string;
  }): RelationHolder[] | Promise<RelationHolder[]>;
};

/** Plan and seat names a principal holds in a tenant, from billing (Stripe Entitlements, a table). */
export type EntitlementSource = {
  entitlementsFor(
    principal: { readonly id: string },
    options: { readonly tenant?: string },
  ): string[] | Promise<string[]>;
};

export function memoryEntitlementSource(
  entries: Readonly<Record<string, readonly string[]>>,
): EntitlementSource {
  return {
    entitlementsFor(_principal, options) {
      return options.tenant === undefined
        ? []
        : [...(entries[options.tenant] ?? [])];
    },
  };
}

export type JwtClaims = {
  readonly iss?: string;
  readonly sub?: string;
  readonly aud?: string | readonly string[];
  readonly exp?: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly [key: string]: unknown;
};

export type TokenFailureCause =
  | "invalid-signature"
  | "expired"
  | "not-yet-valid"
  | "wrong-audience"
  | "wrong-issuer"
  | "wrong-token-type"
  | "alg-not-allowed"
  | "alg-none"
  | "unknown-kid"
  | "malformed"
  | "encrypted-token"
  | "dpop-proof-invalid"
  | "mtls-binding-mismatch"
  | "sender-constraint-required"
  | "token-in-query"
  | "invalid-claims"
  | "invalid-chain"
  | "jwks-unavailable"
  | "discovery-unavailable"
  | "discovery-mismatch";

export type VerifiedToken<TClaims extends JwtClaims = JwtClaims> = {
  readonly ok: true;
  readonly claims: TClaims;
  readonly header: {
    readonly alg: string;
    readonly kid?: string;
    readonly typ?: string;
  };
};

export type VerificationFailure = {
  readonly ok: false;
  readonly reason: "invalid-token";
  readonly cause: TokenFailureCause;
};

export type TokenVerifier<TClaims extends JwtClaims = JwtClaims> = {
  verify(
    token: string,
    expectations: {
      readonly typ?: string | readonly string[];
      readonly audience?: string | readonly string[];
      readonly issuer?: string;
      readonly clockTolerance?: number;
    },
  ): Promise<VerifiedToken<TClaims> | VerificationFailure>;
};

export type TokenSigner = {
  sign(
    payload: Readonly<Record<string, unknown>>,
    options: {
      readonly typ:
        | "permdock-snapshot+jwt"
        | "permdock-approval+jwt"
        | "permdock-decisions+jwt"
        | "permdock-policy+jwt"
        | "permdock-capability+jwt";
      readonly audience?: string | readonly string[];
      readonly expiresAt?: number;
    },
  ): Promise<string>;
  readonly kid?: string;
  jwks?(): Promise<{ readonly keys: readonly JsonWebKeyLike[] }>;
};

export type SubjectResolver<
  TInput,
  TPrincipal extends Principal = Principal,
> = (
  input: TInput,
  options?: { readonly tenant?: string },
) => Subject<TPrincipal> | Promise<Subject<TPrincipal>>;

export type Snapshot = {
  readonly v: 1;
  readonly issuedAt: number;
  readonly subject: {
    readonly principal: {
      readonly id: string;
      readonly roles: readonly string[];
      readonly plans?: readonly string[];
      readonly tenant?: string;
      readonly memberships?: readonly Membership[];
    } | null;
    readonly delegation?: Subject["delegation"];
    readonly context: Readonly<Record<string, unknown>>;
  };
  /** Roles held in the active tenant, in rank order. */
  readonly roles: readonly string[];
  /** The distinct `meta.audience` values of `roles`, in rank order; absent when none has one. */
  readonly audiences?: readonly string[];
  readonly grants: readonly SnapshotGrant[];
  readonly tenants: readonly string[];
  readonly include?: readonly string[];
  readonly simulated?: true;
  readonly expiresAt?: number;
  readonly vocabulary?: {
    readonly roles?: Readonly<Record<string, Role>>;
    readonly plans?: Readonly<Record<string, Plan>>;
  };
  /** The policy's scopes in order, so a client checks the row against each membership's instance. */
  readonly scopes?: readonly SnapshotScope[];
  /** One entry per tenant in `tenants`: what the subject may hand out there. Absent without tenants. */
  readonly assignable?: readonly SnapshotAssignable[];
  /**
   * Allow grants of held roles that only a plan the subject lacks keeps
   * from applying; they grant nothing and name the plan a denial asks for.
   */
  readonly notEntitled?: readonly SnapshotNotEntitled[];
  /**
   * The permission keys the policy's delegations let the actor use for the
   * principal, sorted; present only when one applies. Outside it a check is
   * `not-delegated`; inside it a token delegation, when there is one, must
   * still cover.
   */
  readonly delegated?: readonly string[];
};

/** A grant the subject would hold on another plan: its permission, role and `to`. */
export type SnapshotNotEntitled = {
  readonly permission: string;
  readonly role: string | null;
  readonly to: Grantee | readonly Grantee[];
};

/** One declared scope as a snapshot carries it. */
export type SnapshotScope = {
  readonly name: string;
  readonly key: string;
  readonly within?: string;
  /** Resources whose rows this scope's key partitions, from their `memberOf` relations. */
  readonly resources?: readonly string[];
};

/** The declared roles and the custom-role ceiling the subject may assign in one tenant. */
export type SnapshotAssignable = {
  readonly tenant: string;
  readonly roles: readonly string[];
  readonly permissions: readonly Permission[];
  /** Permission key to the levels the subject may hand out; only permissions whose resource declares levels. */
  readonly levels?: Readonly<Record<string, readonly string[]>>;
};

export type SnapshotGrant = {
  readonly permission: string;
  readonly effect: "allow" | "deny";
  readonly role: string | null;
  readonly to: Grantee | readonly Grantee[];
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: "human" | ApprovalRequirement;
  /** A scope name or one resource; absent for a global grant. */
  readonly scope?: string | { readonly resource: string };
  readonly membership?: Membership;
  readonly portable?: false;
  readonly fields?: readonly string[];
  /** When the grant applies (Unix seconds, `from` inclusive, `until` exclusive); absent means always. */
  readonly validity?: GrantValidity;
};

/**
 * What a policy grants, as JSON a client builds snapshots from without the
 * policy: `localSnapshotManifest(policy)` writes it, `localSnapshot` in
 * `permdock/react-native` reads it.
 */
export type LocalSnapshotManifest = {
  readonly v: 1;
  readonly scopes?: readonly SnapshotScope[];
  readonly vocabulary?: Snapshot["vocabulary"];
  /** Declared role names; a custom role cannot take one. */
  readonly roles: readonly string[];
  /** Declared role names in rank order, when an `assigns` graph ranks them. */
  readonly rank?: readonly string[];
  /** Every declared grant, without a membership. */
  readonly grants: readonly SnapshotGrant[];
  /** Per custom-role scope (`global` for platform roles): the grants each entry resolves to. */
  readonly custom: Readonly<Record<string, LocalCustomRoleTable>>;
};

/** Grants a custom role entry resolves to, held by a placeholder role the client renames. */
export type LocalCustomRoleTable = {
  /** `{ permission }` per permission key, and `{ permission, level }` per declared level. */
  readonly permissions: Readonly<
    Record<
      string,
      {
        readonly all: readonly SnapshotGrant[];
        readonly levels?: Readonly<Record<string, readonly SnapshotGrant[]>>;
      }
    >
  >;
  /** `includes: [role]` per declared role. */
  readonly includes: Readonly<Record<string, readonly SnapshotGrant[]>>;
};

export type SnapshotSource = {
  get(): Promise<Snapshot | string> | Snapshot | string;
  subscribe?(listener: () => void): () => void;
};

export type WhereCompiler<TTarget, TOptions = unknown> = (
  condition: Condition,
  target: TTarget,
  options?: TOptions,
) => unknown;

export type LimitConsumeInput = {
  readonly key: string;
  readonly subjectId: string;
  readonly count: number;
  readonly per: string;
  readonly now?: number;
  /** The active tenant; a quota counts per subject and tenant. */
  readonly tenant?: string;
};

export type LimitRemaining = {
  readonly remaining: number;
};

export type LimitStore = {
  consume(input: LimitConsumeInput): Promise<LimitRemaining> | LimitRemaining;
  remaining(input: LimitConsumeInput): LimitRemaining | undefined;
};

export type DecisionSink = {
  write(events: readonly SinkEvent[]): Promise<void> | void;
  flush?(): Promise<void>;
};

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

/**
 * Looks up the credential an API key stands for. `null` for a key that is
 * malformed, unknown, revoked or whose secret does not match; never throws
 * for bad input. Verification is the application's (or `apiKeyVerifier`'s),
 * never core's.
 */
export type CredentialVerifier = {
  verify(secret: string): Credential | null | Promise<Credential | null>;
  /**
   * Records a successful use at `at` (Unix seconds), for a `lastUsedAt`
   * column. Called after a key resolved and not awaited; a throw or a
   * rejection is ignored, so it never changes the subject.
   */
  touch?(id: string, at: number): void | Promise<void>;
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
    readonly to?: Grantee | readonly Grantee[];
    readonly hosted?: HostedGrantRef;
    readonly breakGlass?: true;
  };
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

/** What one tenant configures for itself. Every field only tightens. */
export type TenantSettings = {
  /** Rules for API keys created in, or used against, this tenant. */
  readonly credentials?: CredentialPolicy;
};

/**
 * Per-tenant settings, a subject input like `RoleSource`: they tighten what
 * a key may be and never grant. A throw denies.
 */
export type SettingsSource = {
  settingsFor(
    tenant: string,
  ): TenantSettings | undefined | Promise<TenantSettings | undefined>;
};

export function memorySettings(
  settings: Readonly<Record<string, TenantSettings>>,
): SettingsSource {
  const byTenant = new Map(Object.entries(settings));
  return Object.freeze({
    settingsFor(tenant: string): TenantSettings | undefined {
      return byTenant.get(tenant);
    },
  });
}

export function memoryRoleSource(
  customRoles: readonly CustomRole[],
): RoleSource {
  const byTenant = new Map<string, CustomRole[]>();
  const global: CustomRole[] = [];
  for (const role of customRoles) {
    if (role.tenant === undefined) {
      global.push(role);
      continue;
    }
    const list = byTenant.get(role.tenant) ?? [];
    list.push(role);
    byTenant.set(role.tenant, list);
  }
  return {
    rolesFor(tenant: string): CustomRole[] {
      return byTenant.get(tenant) ?? [];
    },
    globalRoles(): CustomRole[] {
      return global;
    },
  };
}
