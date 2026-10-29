import type { WhereShorthand, Condition } from "../conditions/index.ts";
import type { AppData, MetaValue, AppDataSchema } from "./app-data.ts";
import type { Approver, ApproverInput } from "./approvers.ts";
import type { POLICY_SCOPES } from "./brands.ts";
import type { AppObligation } from "./decision.ts";
import type { GranteeInput, Grantee, ActorGrantee } from "./grantee.ts";
import type { DecisionProvider } from "./interfaces.ts";
import type { ActorKind, MembershipVia } from "./open-union.ts";
import type {
  Permission,
  PermissionKind,
  PermissionTree,
  ResourceNode,
} from "./permission-types.ts";
import type { POLICY_X } from "./policy-fingerprint.ts";
import type { Scope, PolicyScopesInput, ScopeNames } from "./scopes.ts";
import type { Principal, Actor, Delegation } from "./subject.ts";
import type { Instant } from "./time.ts";
import type { RoleMeta, RoleTree, PlanTree } from "./vocabulary.ts";

export type ClosureContext = {
  readonly subject: {
    readonly principal: Principal | null;
    readonly actor?: unknown;
    readonly delegation?: unknown;
    readonly context: Readonly<Record<string, unknown>>;
  };
  readonly actor?: unknown;
  readonly delegation?: unknown;
  readonly context: Readonly<Record<string, unknown>>;
};

export type ClosureGrantFn<T = unknown> = (
  data: T,
  ctx: ClosureContext,
) => boolean;

/** Who else may approve once a request has waited `after`. */
export type ApprovalEscalation = {
  /** Seconds from the request's creation. */
  readonly after: number;
  readonly to: Approver | readonly Approver[];
};

/** One group of approvers; `quorum` distinct approvers of `by` complete it. */
export type ApprovalStage = {
  readonly by: Approver | readonly Approver[];
  /** Absent means 1. */
  readonly quorum?: number;
  /**
   * After `after`, `to` may approve this stage as well as `by`; other stages
   * are unaffected.
   */
  readonly escalation?: ApprovalEscalation;
};

/**
 * `'any'`: `quorum` approvers from `by`. `'all'`: every stage completes, in any
 * order. `'sequential'`: stages complete in order; an approver signs only the
 * first incomplete stage. An approver signs once per request.
 */
export type ApprovalCombine = "any" | "all" | "sequential";

/**
 * `'authorize'` (the default): someone other than the request's principal
 * approves. `'confirm'`: the principal may approve their own request. Neither
 * is met by an approver acting through an agent or a delegated token.
 */
export type ApprovalMode = "confirm" | "authorize";

/**
 * What an `'authorize'` approval does when nobody else can approve: `'confirm'`
 * lets the request's principal approve it, but only while the handler's
 * `approverDirectory` lists no other eligible approver. Without a directory, or
 * when it answers `null`, the principal stays refused.
 */
export type ApprovalFallback = "confirm";

export type ApprovalRequirement = {
  /** Set when `combine` is `'any'` (the default); absent under `stages`. */
  readonly by?: Approver | readonly Approver[];
  /** Absent means `'any'`. */
  readonly combine?: ApprovalCombine;
  /** Set when `combine` is `'all'` or `'sequential'`. */
  readonly stages?: readonly ApprovalStage[];
  /** Absent means `'authorize'`. */
  readonly mode?: ApprovalMode;
  /** Absent means no fallback; see `ApprovalFallback`. */
  readonly fallback?: ApprovalFallback;
  /** `'resource-change'` binds the approval to the row's `version` field. */
  readonly staleOn?: "resource-change";
  /**
   * Distinct approvers a request needs before it is approved under `by`; absent
   * means 1.
   */
  readonly quorum?: number;
  /**
   * Seconds a request stays open; the store's default when absent, and never
   * longer than it.
   */
  readonly ttl?: number;
  readonly escalation?: ApprovalEscalation;
};

export type ApprovalOption =
  | "human"
  | {
      readonly by?: ApproverInput;
      /**
       * `'all'` or `'sequential'` with `stages`; absent means `'any'` with
       * `by`.
       */
      readonly combine?: ApprovalCombine;
      readonly stages?: readonly {
        readonly by: ApproverInput;
        readonly quorum?: number;
        /** After `after` seconds, `to` may approve this stage as well as `by`. */
        readonly escalation?: {
          readonly after: number;
          readonly to: ApproverInput;
        };
      }[];
      /**
       * `'confirm'` lets the request's principal approve it; absent means
       * `'authorize'`.
       */
      readonly mode?: ApprovalMode;
      /**
       * `'confirm'` lets the request's principal approve it when no other
       * eligible approver exists; see `ApprovalFallback`.
       */
      readonly fallback?: ApprovalFallback;
      /**
       * `'resource-change'`: the approval covers the row as it was when it was
       * requested. The resource must declare `version`; once that field
       * changes, resuming denies with `stale-approval`.
       */
      readonly staleOn?: "resource-change";
      /**
       * Distinct approvers needed (an integer of at least 1); the same approver
       * counts once. Absent means 1.
       */
      readonly quorum?: number;
      /**
       * Seconds the request stays open (`1800`); caps the approval store's
       * default.
       */
      readonly ttl?: number;
      /**
       * After `after` seconds (`14_400`), `to` may approve as well as `by`, at
       * any open stage; same kinds as `by`.
       */
      readonly escalation?: {
        readonly after: number;
        readonly to: ApproverInput;
      };
    };

/**
 * A quota on a grant. `hard` (the default) denies past `count`; `soft` grants
 * with an `over-limit` obligation. `alertAt` (a fraction of `count`, above 0
 * and at most 1) adds a `near-limit` obligation once usage reaches it.
 */
export type GrantLimit = {
  readonly count: number;
  /** The window in seconds (`3600` for an hour), aligned to the epoch. */
  readonly per: number;
  readonly mode?: "hard" | "soft";
  readonly alertAt?: number;
};

/** How fresh the subject's authentication must be for an elevated grant. */
export type AssuranceRequirement = {
  /** Seconds since the subject last authenticated (`assurance.authTime`). */
  readonly maxAge?: number;
  /** Authentication context class references, any of which satisfies it. */
  readonly acr?: readonly string[];
  /** Authentication methods, all of which must be present. */
  readonly amr?: readonly string[];
};

/**
 * Time-boxed role activation. A role with `activation` is never held directly:
 * a membership lists it under `eligible`, and `permdock.activate` mints the
 * elevated membership to write.
 */
export type ActivationOption = {
  /** The longest an activation may last, in seconds (`14_400`). */
  readonly maxDuration?: number;
  /** `'required'` denies an activation without a reason. */
  readonly justification?: "required" | "optional";
  /**
   * When set, `activate` returns `approval-required` before the membership can
   * be written.
   */
  readonly approval?: ApprovalOption;
  /** How fresh the activator's authentication must be. */
  readonly assurance?: AssuranceRequirement;
};

export type ActivationSpec = {
  readonly maxDuration?: number;
  readonly justification: "required" | "optional";
  readonly approval?: "human" | ApprovalRequirement;
  readonly assurance?: AssuranceRequirement;
};

/** What a break-glass grant demands before it overrides a deny. */
export type BreakGlassRequirements = {
  /** Purposes of use (`context.purpose`), any of which engages break-glass. */
  readonly purpose?: readonly string[];
  /** `true` denies unless the caller supplies `context.reason`. */
  readonly reason?: boolean;
  readonly assurance?: AssuranceRequirement;
};

export type BreakGlassOptions = {
  /** Names of the deny grants this override lifts; every other deny still wins. */
  readonly overrides?: readonly string[];
  readonly requires?: BreakGlassRequirements;
  /** The longest a break-glass session may last, in seconds. */
  readonly maxDuration?: number;
  /** Follow-ups the grant owes: each becomes an obligation on the decision. */
  readonly obligations?: readonly ("notify" | "review")[];
};

/** The normalized break-glass spec carried on a grant. */
export type BreakGlassSpec = {
  readonly overrides: readonly string[];
  readonly purpose?: readonly string[];
  readonly reason: boolean;
  readonly assurance?: AssuranceRequirement;
  readonly maxDuration?: number;
  readonly obligations: readonly ("notify" | "review")[];
};

/** How a tenant consents to support access, and for how long. */
export type SupportConsent = {
  readonly by: GranteeInput;
  /** The durations a tenant owner may pick, in seconds. */
  readonly durations: readonly number[];
};

export type SupportAccessOptions<S extends string = string> = {
  /** The role a consented support membership holds. */
  readonly role: string;
  /** The scope the support membership sits in; defaults to `tenant`. */
  readonly on?: S;
  /**
   * Every decision under the support membership denies with `actor-required`
   * without an `act`.
   */
  readonly actorRequired?: boolean;
  readonly consent: SupportConsent;
  /**
   * Permissions a support session never reaches, compiled to deny grants scoped
   * to `via: 'support'`.
   */
  readonly forbid?: readonly (Permission | PermissionTree)[];
  /** The subgroup a consented membership records under `member.group`. */
  readonly group?: string;
};

export type SupportSpec = {
  readonly role: string;
  readonly actorRequired: boolean;
  readonly consent: {
    readonly by: Grantee | readonly Grantee[];
    readonly durations: readonly number[];
  };
  readonly group: string;
};

export type GrantOptions<T = Record<string, unknown>> = {
  readonly to?: GranteeInput;
  readonly where?: WhereShorthand<T> | Condition;
  readonly check?: WhereShorthand<T> | Condition;
  readonly approval?: ApprovalOption;
  readonly limit?: GrantLimit;
  readonly reason?: string;
  readonly fields?: readonly (unknown extends T ? string : keyof T & string)[];
  /**
   * A stable name for the grant. On a deny, a `breakGlass` override may lift
   * it; on any grant, it is reported on `decision.matched.name` and on decision
   * events.
   */
  readonly name?: string;
  readonly group?: string;
  /**
   * Display text and app data for the grant, reported on
   * `decision.matched.meta`; never read in evaluation.
   */
  readonly meta?: GrantMeta;
  /**
   * Follow-ups the application owes when this allow grants: each becomes a `{
   * kind: 'app', name, detail? }` obligation on the decision. Allows only.
   */
  readonly obligations?: readonly ObligationInput[];
  /**
   * Purposes of use (`context.purpose`) that make the grant apply;
   * non-portable.
   */
  readonly purpose?: readonly string[];
  /**
   * The grant applies from this instant on (RFC 3339 or an `Instant`); before
   * it an allow denies with `inactive-grant` and a deny does not apply.
   */
  readonly validFrom?: string | Instant;
  /**
   * The grant stops applying at this instant (exclusive; RFC 3339 or an
   * `Instant`).
   */
  readonly validUntil?: string | Instant;
  /**
   * An allow on an instance action counts only on rows whose scope instance (or
   * the whole app, globally) is one where the subject also holds this
   * permission through a role grant without a row condition.
   */
  readonly requires?: Permission | readonly Permission[];
};

/**
 * A grant's metadata. PermDock carries it to decisions, events, snapshots and
 * the catalog and never reads `x`.
 */
export type GrantMeta = {
  readonly description?: string;
  /**
   * Data the application owns. Plain JSON, checked by `definePolicy(…, { x: {
   * grant } })`.
   */
  readonly x?: AppData;
};

/** An app obligation as declared on an allow: its name, or its name and detail. */
export type ObligationInput =
  | string
  | { readonly name: string; readonly detail?: MetaValue };

/**
 * When a grant applies, in Unix seconds. `from` is inclusive, `until`
 * exclusive; either may be absent. Portable: `where()` drops an inactive grant
 * at the decision clock and generated RLS compares against `now()`.
 */
export type GrantValidity = { readonly from?: number; readonly until?: number };

/**
 * A grant's validity in JSON (snapshots, catalogs, `inactive-grant` details):
 * RFC 3339 bounds.
 */
export type WireValidity = { readonly from?: string; readonly until?: string };

/**
 * The actor a policy delegation is for: an actor kind, narrowed to one id when
 * `id` is set, or to one named client when `client` is set (the name the
 * subject resolver gives a verified client id through `clients`).
 */
export type DelegationTarget = {
  readonly kind: ActorKind;
  readonly id?: string;
  readonly client?: string;
};

/**
 * A normalised policy delegation: holders of `from` let actors matching `to`
 * use `permissions` (keys) on their behalf while `validity` holds, without a
 * token saying so. Attenuation only: the principal's grants still decide.
 */
export type PolicyDelegation = {
  readonly from: Grantee | readonly Grantee[];
  readonly to: DelegationTarget;
  readonly permissions: readonly string[];
  /**
   * The keys of `permissions` whose `readOnlyHint` is true: all a `readOnly`
   * actor may use.
   */
  readonly readOnly: readonly string[];
  readonly validity?: GrantValidity;
};

export type DelegationInput = {
  /**
   * Who hands over: the same subject-only selectors as `approval.by` (a role,
   * `authenticated()`, a plan, `assurance()`); not `relation()`.
   */
  readonly from: GranteeInput;
  /**
   * Which actor may act: `actor('eve')`, an actor kind, `{ kind, id }` for one
   * agent, or `{ kind, client }` for one named OAuth client.
   */
  readonly to: ActorGrantee | string | DelegationTarget;
  /** The leaves or subtrees the actor may use; a deny grant still applies. */
  readonly permissions: readonly (Permission | PermissionTree)[];
  readonly validFrom?: string | Instant;
  readonly validUntil?: string | Instant;
};

/**
 * A declared scope name (or the `tenant` / `team` alias), or the resource a
 * role is held on.
 */
export type RoleScope<S extends string = string> =
  | S
  | Permission
  | PermissionTree
  | readonly (Permission | PermissionTree)[];

export type RoleOptions<S extends string = string> = {
  readonly on?: RoleScope<S>;
  readonly assignable?: boolean;
  /** Roles nobody may hold together with this one in the same scope instance. */
  readonly exclusiveWith?: readonly string[];
  /**
   * Fewest holders a scope instance keeps (checked at commit); default 0. Needs
   * a named-scope `on`.
   */
  readonly min?: number;
  /** Most holders a scope instance may have. Needs a named-scope `on`. */
  readonly max?: number;
  /**
   * The holder count of a scope instance never changes: the role only moves by
   * transfer.
   */
  readonly transferOnly?: boolean;
  /**
   * Roles a holder may assign and revoke. Once any role declares `assigns`, a
   * role nobody lists is assigned only by `meta.manageRoles` holders.
   */
  readonly assigns?: readonly string[];
  /**
   * Membership kinds (`via`) that may hold the role; others hold it for
   * nothing.
   */
  readonly for?: readonly string[];
  readonly meta?: RoleMeta;
  /**
   * Time-boxed activation: the role becomes eligible-only and `activate` mints
   * its membership.
   */
  readonly activation?: ActivationOption;
  /** Reserved for restricted credentials; setting it throws until it ships. */
  readonly restricted?: never;
};

/** Where a grant applies: `'global'`, a declared scope name, or one resource. */
export type GrantScope = string | { readonly resource: string };

export type Grant = {
  readonly permission: Permission;
  readonly effect: "allow" | "deny";
  readonly to: Grantee | readonly Grantee[];
  readonly role: string | null;
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: "human" | ApprovalRequirement;
  readonly portable: boolean;
  /**
   * Set when `portable` is false only because the grant reads the relation
   * graph.
   */
  readonly graph?: true;
  readonly closure?: ClosureGrantFn;
  readonly limit?: GrantLimit;
  readonly fields?: readonly string[];
  readonly scope: GrantScope;
  /**
   * The grant's stable name: a `breakGlass` override lifts a named deny, and
   * `decision.matched.name` reports it.
   */
  readonly name?: string;
  readonly group?: string;
  readonly meta?: GrantMeta;
  /** App obligations an allow adds to its granted decision. */
  readonly obligations?: readonly AppObligation[];
  /**
   * Purposes of use that make the grant apply (`context.purpose`);
   * non-portable.
   */
  readonly purpose?: readonly string[];
  /**
   * Set on a break-glass allow: it overrides named denies and carries
   * obligations.
   */
  readonly breakGlass?: BreakGlassSpec;
  /**
   * The membership kind (`via`) this grant applies under; others never match
   * it.
   */
  readonly viaOnly?: MembershipVia;
  /** Set only on a grant merged from a hosted policy document. */
  readonly hosted?: HostedGrantRef;
  /** When the grant applies; absent means always. */
  readonly validity?: GrantValidity;
  /**
   * Set on a custom-role grant narrowed by a resource level
   * (`CustomRoleGrant.level`).
   */
  readonly level?: string;
  /**
   * The permission key the subject must also hold, through a role, on the row's
   * scope instance or globally.
   */
  readonly requires?: readonly string[];
};

/** Which hosted policy document and grant a merged grant came from. */
export type HostedGrantRef = {
  readonly document: string;
  readonly grant: string;
};

export type RoleBinding<S extends string = string> = {
  readonly name: string;
  readonly grants: readonly Grant[];
  readonly on?: RoleScope<S>;
  readonly assignable: boolean;
  readonly exclusiveWith?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly transferOnly?: boolean;
  readonly assigns?: readonly string[];
  readonly for?: readonly string[];
  readonly meta?: RoleMeta;
  /**
   * Time-boxed activation: the role is eligible-only, and `activate` mints its
   * membership.
   */
  readonly activation?: ActivationSpec;
  /**
   * Support access: consent and `actorRequired` for a vendor-support
   * membership.
   */
  readonly support?: SupportSpec;
};

export type ValidateMode = "boundary" | "always" | "never";

/**
 * The declared scopes, in declaration order; empty when the policy declares
 * none.
 */
export type PolicyScopes = readonly Scope[];

export type PolicyVocabulary = {
  readonly permissions: PermissionTree;
  readonly roles?: RoleTree;
  readonly plans?: PlanTree;
};

export type VocabularyFromInput<Input> = Input extends PolicyVocabulary
  ? Input
  : {
      readonly permissions: Input & PermissionTree;
      readonly roles?: RoleTree;
      readonly plans?: PlanTree;
    };

export type Policy<
  TUser = unknown,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
  S extends PolicyScopesInput = PolicyScopesInput,
> = {
  readonly permissions: V["permissions"];
  readonly roles: readonly RoleBinding[];
  readonly rolesByName: ReadonlyMap<string, RoleBinding>;
  readonly grants: readonly Grant[];
  readonly vocabulary: V;
  readonly scopes: PolicyScopes;
  // Bivariant in `TUser`, so a `Policy<User>` passes where a `Policy` is accepted.
  // oxlint-disable-next-line typescript/method-signature-style -- bivariant in TUser
  principal(user: TUser): TPrincipal | null;
  // oxlint-disable-next-line typescript/method-signature-style -- bivariant in TUser
  subject(user: TUser): TPrincipal | null;
  // oxlint-disable-next-line typescript/method-signature-style -- bivariant in TUser
  context?(
    user: TUser,
  ):
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  readonly validate: ValidateMode;
  readonly onDenied?: (decision: unknown) => never | void;
  readonly fingerprint: string;
  readonly resources: ReadonlyMap<string, ResourceNode>;
  /**
   * The app data schemas `definePolicy` was given; symbol-keyed so freezing the
   * policy leaves the schemas alone.
   */
  readonly [POLICY_X]?: PolicyAppDataSchemas;
  readonly [POLICY_SCOPES]?: S;
  readonly providers?: readonly DecisionProvider[];
  /**
   * Permission keys a hosted policy document may grant or deny; empty by
   * default.
   */
  readonly hostable: readonly string[];
  /**
   * Permission keys that deny with `stale-credentials` when the subject's token
   * is behind the source.
   */
  readonly fresh?: readonly string[];
  /**
   * Policy delegations in declaration order; absent or empty when the policy
   * declares none.
   */
  readonly delegations?: readonly PolicyDelegation[];
  /**
   * Grant levels by resource (`resource(…, { levels })`), normalised; absent
   * when none are declared.
   */
  readonly levels?: PolicyLevels;
  /** Resources declared with `orderedLevels: true`, sorted; absent when none. */
  readonly orderedLevels?: readonly string[];
  /**
   * Coarse OAuth scopes in declaration order; absent when the policy declares
   * none.
   */
  readonly oauthScopes?: readonly PolicyOAuthScope[];
  readonly index: PolicyIndex;
};

/**
 * A coarse OAuth scope an authorization server issues (`mcp:read`) and the
 * permission keys it covers, with their own scopes (`task:read`).
 */
export type PolicyOAuthScope = {
  readonly scope: string;
  readonly permissions: readonly string[];
  readonly scopes: readonly string[];
};

/**
 * Lookups built once per policy, so a decision does not rescan every role and
 * grant.
 */
export type PolicyIndex = {
  readonly declaredRoles: ReadonlySet<string>;
  readonly supports: readonly SupportSpec[];
  /** The grants `grantList` returns, by permission key, in the same order. */
  readonly grantsByKey: ReadonlyMap<string, readonly Grant[]>;
};

export type GrantCondition<T, K extends PermissionKind> = K extends "collection"
  ? Omit<GrantOptions<T>, "where" | "fields"> | ClosureGrantFn<T>
  : GrantOptions<T> | ClosureGrantFn<T>;

/** Resource name to level name to its normalised condition. */
export type PolicyLevels = Readonly<
  Record<string, Readonly<Record<string, Condition>>>
>;

/**
 * Standard Schemas for the app data a policy carries. `grant` checks every
 * grant's `meta.x` at `definePolicy` and throws on invalid data; `membership`
 * checks `Membership.x` as each subject resolves, dropping an invalid `x`
 * (never the membership) with an `on('auth')` event of reason `schema`.
 */
export type PolicyAppDataSchemas = {
  readonly grant?: AppDataSchema<unknown>;
  readonly membership?: AppDataSchema<unknown>;
};

export type PolicyOptions<
  TUser,
  TPrincipal extends Principal,
  S extends PolicyScopesInput = PolicyScopesInput,
> = {
  readonly x?: PolicyAppDataSchemas;
  readonly roles?: readonly RoleBinding<ScopeNames<S>>[];
  readonly grants?: readonly (
    | Omit<Grant, "role" | "scope">
    | readonly Omit<Grant, "role" | "scope">[]
    | Grant
  )[];
  /**
   * Named scopes in order, each with the row field holding its id and an
   * optional parent (`within`, an earlier scope). `tenant` and `team` alias the
   * first and second scope.
   */
  readonly scopes?: S;
  /**
   * Maps the application's user to the principal PermDock decides for; `null`
   * is anonymous.
   */
  readonly subject: (user: TUser) => TPrincipal | null;
  readonly context?: (
    user: TUser,
  ) =>
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  readonly validate?: ValidateMode;
  readonly onDenied?: (decision: unknown) => never | void;
  readonly providers?: readonly DecisionProvider[];
  /**
   * Leaves or subtrees a hosted policy document (`PolicySource`) may touch. The
   * default is none, so a policy without it ignores every hosted grant.
   */
  readonly hostable?: readonly (Permission | PermissionTree)[];
  /**
   * Sensitive permissions that need an up-to-date token: when the subject's
   * memberships come from a token behind the `MembershipSource` version, they
   * deny with `stale-credentials`.
   */
  readonly fresh?: readonly (Permission | PermissionTree)[];
  /**
   * Standing delegations: holders of `from` let actors matching `to` use
   * `permissions` for them without a token saying so. A token delegation on the
   * call still applies as well; both must cover.
   */
  readonly delegations?: readonly DelegationInput[];
  /**
   * Coarse OAuth scopes the authorization server issues, each covering
   * permissions: a token holding `mcp:read` is delegated every permission
   * listed under it, as if it held each permission's own scope. Scope
   * challenges name the first coarse scope that covers the permission.
   */
  readonly oauthScopes?: Readonly<
    Record<string, readonly (Permission | PermissionTree)[]>
  >;
};

export type MembershipFixture = {
  readonly principal?: string;
  readonly tenant?: string;
  readonly roles: readonly string[];
};

export type SeparationConflict = {
  readonly principal: string;
  readonly tenant?: string;
  readonly roles: readonly [string, string];
};

export type PrincipalOf<P> =
  P extends Policy<unknown, infer TPrincipal> ? TPrincipal : Principal;

export type SubjectOf<P> = {
  readonly principal: PrincipalOf<P> | null;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly context: Readonly<Record<string, unknown>>;
  readonly session?: string;
  readonly expiresAt?: number;
};
