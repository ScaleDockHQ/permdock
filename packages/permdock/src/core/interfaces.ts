import type { Condition } from "../conditions/ast.ts";
import type { Credential, CredentialPolicy } from "./credential.ts";
import type { Decision } from "./decision.ts";
import type { SinkEvent } from "./event-types.ts";
import type { Permission } from "./permission-types.ts";
import type { Snapshot } from "./snapshot-types.ts";
import type {
  CustomRole,
  JsonWebKeyLike,
  Membership,
  Principal,
  Subject,
} from "./subject.ts";
import type { SupportSessionPolicy } from "./support-session.ts";
import type { Instant } from "./time.ts";

export type DecisionProvider = {
  readonly name: string;
  handles: (permission: Permission) => boolean;
  decide: (request: {
    readonly permission: Permission;
    readonly data?: unknown;
    readonly subject: Subject;
    readonly local: Decision;
  }) => Promise<Decision>;
  /**
   * Ids of the resources of `permission.resource` the subject may act on.
   * `null` means the provider could not answer and every row is denied;
   * `undefined` means it cannot list, and each row is decided on its own.
   */
  permitted?: (request: {
    readonly permission: Permission;
    readonly subject: Subject;
  }) => Promise<readonly string[] | null | undefined>;
};

/**
 * Shares one read per key within one `getPermDock` call: the first call runs
 * `read`, every later call with the same key gets its answer. A source created
 * once at module scope uses it so the reads of one instance share a single
 * query and no answer outlives the instance.
 */
export type SourceMemo = <T>(key: string, read: () => T) => T;

/** What `getPermDock` passes to every source call besides its query. */
export type SourceContext = {
  /** Absent when the source is called outside `getPermDock`. */
  readonly memo?: SourceMemo;
};

/**
 * Whether an instance answers reads or writes: `read` may judge a token fresh
 * from a shared `VersionCache` within its `maxStaleMs`; `write` reads the
 * version live.
 */
export type Intent = "read" | "write";

/** The custom-role sources' second argument. */
export type CustomRoleContext = SourceContext & {
  readonly held: readonly string[];
};

export type CustomRoleSource = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  /**
   * The custom roles of one tenant. `getPermDock` passes `held`, the role names
   * the subject's live memberships hold there, declared or not, so a source can
   * skip its read when none of them is a custom role.
   */
  rolesFor: (
    tenant: string,
    context?: CustomRoleContext,
  ) => CustomRole[] | Promise<CustomRole[]>;
  assignable?: (tenant: string) => string[] | Promise<string[]>;
  /**
   * Platform custom roles (`scope: 'global'`), read once per signed-in subject,
   * with `held`, the global role names the subject holds. A role here with a
   * tenant is ignored.
   */
  globalRoles?: (
    context?: CustomRoleContext,
  ) => CustomRole[] | Promise<CustomRole[]>;
  /**
   * Shared custom roles (`shared: true`), defined once for every tenant and
   * read once per subject with a tenant membership, with `held`, the role names
   * its live memberships hold in any tenant. A role here without `shared: true`
   * is ignored.
   */
  sharedRoles?: (
    context?: CustomRoleContext,
  ) => CustomRole[] | Promise<CustomRole[]>;
};

/**
 * A `CustomRoleSource` built for the subject the instance serves, for an
 * adapter option shared by every request: it gets the resolved subject
 * (principal, actor and delegation) and returns that subject's source, or
 * `undefined` for none. A throw reads no custom roles and reports
 * `source-threw`.
 */
export type CustomRoleSourceFactory = (
  subject: Subject,
) => CustomRoleSource | undefined;

/**
 * The principal `MembershipSource.version` is asked about: what its token
 * claims.
 */
export type VersionQuery = {
  readonly id: string;
  readonly roles?: readonly string[];
  readonly memberships?: readonly Membership[];
  readonly authzVersion?: number;
  /** When the token was issued, in seconds since the epoch (`iat`). */
  readonly issuedAt?: number;
};

/** `MembershipSource.version`'s second argument. */
export type VersionContext = SourceContext & {
  /** Absent outside `getPermDock`, where the read is live. */
  readonly intent?: Intent;
};

/** One member of a scope instance, as `MembershipSource.list` returns it. */
export type MemberEntry = {
  readonly principal: { readonly id: string };
  readonly membership: Membership;
};

export type MembershipSource = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  membershipsFor: (
    principal: { readonly id: string; readonly kind?: string },
    options: SourceContext & { readonly tenant?: string },
  ) => Membership[] | Promise<Membership[]>;
  /**
   * Every membership held in one scope instance, for member lists and access
   * reviews.
   */
  list?: (query: {
    readonly scope: string;
    readonly id: string;
  }) => MemberEntry[] | Promise<MemberEntry[]>;
  /**
   * The principal's current authorization version, bumped on every membership
   * change. A token whose `authzVersion` is behind it is stale for the policy's
   * `fresh` permissions. `roles` and `memberships` are what the token claims,
   * so a source can read more than the version in the same call when the claims
   * show it will be needed. `authzVersion` and `issuedAt` (seconds) are the
   * token's, for a `VersionCache`.
   */
  version?: (
    principal: VersionQuery,
    context?: VersionContext,
  ) => number | undefined | Promise<number | undefined>;
  /**
   * The global roles the principal holds now. With `onStale: 'reread'`, a stale
   * token's `principal.roles` is replaced by this answer, so a revoked platform
   * role is lost with the memberships. A throw or rejection leaves no global
   * roles. Without it, a reread keeps the token's roles.
   */
  globalRolesFor?: (
    principal: { readonly id: string; readonly kind?: string },
    context?: SourceContext,
  ) => readonly string[] | Promise<readonly string[]>;
  /**
   * Keep the memberships the verified token carries and read this source only
   * when the token says they were truncated (`claimsFirst`).
   */
  readonly claimsFirst?: boolean;
  /**
   * What a token behind `version` gets. Only permissions the policy marks
   * `fresh` look at staleness: `'deny'` (the default) denies those with
   * `stale-credentials` and leaves every other permission on the token's
   * claims; `'reread'` replaces the token's memberships (and global roles, when
   * the source has `globalRolesFor`) with a live read for the whole subject, so
   * no decision keeps a revoked grant.
   */
  readonly onStale?: "deny" | "reread";
};

/** An object's parent chain, as `RelationSource.ancestors` returns it. */
export type RelationChain = {
  /** Whether the object itself is restricted: nothing above it reaches it. */
  readonly restricted?: boolean;
  /**
   * Ancestors nearest first, at most `depth`; a restricted one ends the walk
   * after itself.
   */
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

/**
 * A group holding a relation on an object: whoever holds `relation` on the
 * group's instance holds it too.
 */
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
 * The object graph: parent chains, links and who holds a relation on an object.
 * A source answers facts and never decides; a thrown or rejected call, or a
 * Promise the instance has not loaded, denies with `relation-unavailable`.
 */
export type RelationSource = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  /**
   * With `through: 'parent'`, the parent chain; with a link name, the one
   * instance that link points to (`depth` is then 1).
   */
  ancestors: (query: {
    readonly resource: string;
    readonly id: string;
    readonly through: string;
    readonly depth: number;
  }) => RelationChain | Promise<RelationChain>;
  related: (query: {
    readonly resource: string;
    readonly id: string;
    readonly relation: string;
  }) => RelationHolder[] | Promise<RelationHolder[]>;
  row?: (query: {
    readonly resource: string;
    readonly id: string;
  }) =>
    | Readonly<Record<string, unknown>>
    | null
    | undefined
    | Promise<Readonly<Record<string, unknown>> | null | undefined>;
};

/**
 * Plan and seat names a principal holds in a tenant, from billing (Stripe
 * Entitlements, a table).
 */
export type EntitlementSource = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  entitlementsFor: (
    principal: { readonly id: string },
    options: { readonly tenant?: string },
  ) => string[] | Promise<string[]>;
};

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
  /** Names the implementation in errors and events. */
  readonly name?: string;
  verify: (
    token: string,
    expectations: {
      readonly typ?: string | readonly string[];
      readonly audience?: string | readonly string[];
      readonly issuer?: string;
      readonly clockTolerance?: number;
    },
  ) => Promise<VerifiedToken<TClaims> | VerificationFailure>;
};

export type TokenSigner = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  sign: (
    payload: Readonly<Record<string, unknown>>,
    options: {
      readonly typ:
        | "vnd.permdock.snapshot+jwt"
        | "vnd.permdock.approval+jwt"
        | "vnd.permdock.policy+jwt"
        | "vnd.permdock.capability+jwt"
        | "vnd.permdock.run+jwt"
        | "vnd.permdock.support-session+jwt"
        | "vnd.permdock.evidence+jwt"
        /**
         * RFC 9068: the `PermDock-Approver` token `cloud().approvals.resolve`
         * sends.
         */
        | "at+jwt"
        /** RFC 8417: a Security Event Token from `signSet` in `permdock/ssf`. */
        | "secevent+jwt";
      /** `aud`; a signer with no default audience refuses to sign without one. */
      readonly audience?: string | readonly string[];
      /** `exp`, a NumericDate; one hour after `iat` when absent. */
      readonly expiresAt?: number;
      /**
       * `iat`, a NumericDate: the artefact's issue time. The signer's clock
       * when absent.
       */
      readonly issuedAt?: number;
      /** `jti`: the artefact's id. A fresh UUID when absent. */
      readonly jti?: string;
    },
  ) => Promise<string>;
  readonly kid?: string;
  jwks?: () => Promise<{ readonly keys: readonly JsonWebKeyLike[] }>;
};

export type SubjectResolver<
  TInput,
  TPrincipal extends Principal = Principal,
> = (
  input: TInput,
  options?: { readonly tenant?: string },
) => Subject<TPrincipal> | Promise<Subject<TPrincipal>>;

export type SnapshotSource = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  get: () => Promise<Snapshot | string> | Snapshot | string;
  subscribe?: (listener: () => void) => () => void;
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
  /** The window in seconds; windows are aligned to the epoch. */
  readonly per: number;
  /** The decision clock; the store reads the clock when absent. */
  readonly now?: Instant;
  /** The active tenant; a quota counts per subject and tenant. */
  readonly tenant?: string;
};

export type LimitRemaining = { readonly remaining: number };

export type LimitStore = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  consume: (
    input: LimitConsumeInput,
  ) => Promise<LimitRemaining> | LimitRemaining;
  remaining: (input: LimitConsumeInput) => LimitRemaining | undefined;
};

export type DecisionSink = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  write: (events: readonly SinkEvent[]) => Promise<void> | void;
  flush?: () => Promise<void>;
};

/**
 * Looks up the credential an API key stands for. `null` for a key that is
 * malformed, unknown, revoked or whose secret does not match; never throws for
 * bad input. Verification is the application's (or `apiKeyVerifier`'s), never
 * core's.
 */
export type CredentialVerifier = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  verify: (secret: string) => Credential | null | Promise<Credential | null>;
  /**
   * Records a successful use at `at`, for a `lastUsedAt` column. Called after a
   * key resolved and not awaited; a throw or a rejection is ignored, so it
   * never changes the subject.
   */
  touch?: (id: string, at: Instant) => void | Promise<void>;
};

/** What one tenant configures for itself. Every field only tightens. */
export type TenantSettings = {
  /** Rules for API keys created in, or used against, this tenant. */
  readonly credentials?: CredentialPolicy;
  /** Rules for support sessions started in this tenant. */
  readonly supportSessions?: SupportSessionPolicy;
};

/**
 * Per-tenant settings, a subject input like `CustomRoleSource`: they tighten
 * what a key may be and never grant. A throw denies.
 */
export type SettingsSource = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  settingsFor: (
    tenant: string,
  ) => TenantSettings | undefined | Promise<TenantSettings | undefined>;
};
