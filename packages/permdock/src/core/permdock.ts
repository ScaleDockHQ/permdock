import type { Condition } from "../conditions/ast.ts";
import type { AppData } from "./app-data.ts";
import type {
  ApprovalPolicies,
  LoadedApprovalPolicies,
} from "./approval-policies.ts";
import type { Decision, ExplainedDecision } from "./decision.ts";
import type { AuthEvent, DecisionEvent } from "./event-types.ts";
import type { HostedPolicies } from "./hosted.ts";
import type { InstanceEnv } from "./instance-env.ts";
import type {
  DecisionSink,
  EntitlementSource,
  MembershipSource,
  RelationSource,
  CustomRoleSource,
  CustomRoleSourceFactory,
  SettingsSource,
  TokenSigner,
} from "./interfaces.ts";
import type { Limits } from "./limits.ts";
import type { PermittedIdsOptions } from "./may-use.ts";
import type { AdapterId } from "./open-union.ts";
import type { Operation } from "./operations.ts";
import type { Permission, ResourceNode } from "./permission-types.ts";
import type { Policy, PolicyVocabulary } from "./policy-types.ts";
import type { PrincipalSource } from "./principal-source.ts";
import type { Snapshot } from "./snapshot-types.ts";
import type {
  Actor,
  CustomRole,
  Delegation,
  Membership,
  Principal,
  Subject,
} from "./subject.ts";
import type { Instant } from "./time.ts";
import type { Boundary } from "./validation.ts";
import type { PlanTree, Role, RoleTree } from "./vocabulary.ts";

import { withApp } from "./app.ts";
import { compact } from "./compact.ts";
import { buildInstance } from "./instance.ts";
import { asMembershipSource } from "./memberships.ts";
import { resolveSubject } from "./resolve-subject.ts";
import {
  assignableNamesFor,
  customRolesFor,
  roleSourceFor,
} from "./role-loading.ts";
import { type Scope, scopeList } from "./scopes.ts";
import { parseSnapshot } from "./snapshot.ts";
import { heldRoleNamesIn, tenantsOf } from "./tenancy.ts";
import { isThenable } from "./thenable.ts";

export type DecideOptions = {
  /** `true` skips schema validation for a row the server loaded itself. Otherwise `data` is validated against the resource schema first (`validate: 'boundary'`), and a failure denies with reason `validation`. */
  readonly trusted?: boolean;
  /** Where untrusted data came from, reported on validation errors. Defaults to `'manual'`. */
  readonly boundary?: Boundary;
  /** Decision clock, for expiries and limits; a `Temporal.Instant` fits. Defaults to the current time. */
  readonly now?: Instant;
  /** The call that produced the decision, reported on the decision event. Defaults to `'decide'`. */
  readonly call?: DecisionEvent["call"];
  /** The adapter that made the call, reported on the decision event. */
  readonly adapter?: AdapterId;
  /** The model id the decision is about or that drove the call (`'openai/gpt-5'`), reported on the decision event. Never read when deciding. */
  readonly model?: string;
  /** Per-call unauthorized handler for `assert`; runs before instance and policy handlers. */
  readonly onDenied?: (decision: Decision) => never | void;
  /** The field being read or written; only grants whose `fields` cover it match. */
  readonly field?: string;
  /** `true` attaches a `trace` to the decision: the grants evaluated, matched and skipped. Off by default and free when off. */
  readonly explain?: boolean;
  /**
   * A declared scope name: only memberships of that scope answer the check.
   * Naming the first scope keeps nested memberships out of a tenant-level
   * guard on a collection action. Global roles still apply; resource roles
   * and memberships of other scopes are skipped with reason `scope`.
   */
  readonly scope?: string;
  /**
   * The operation the call decides, for `ApprovalPolicySource` entries that
   * match on `meta.risk` and `meta.effects`. Surfaces that decide an
   * operation (agent tools, workflow steps, `protect(operation)`) pass it.
   */
  readonly operation?: Pick<Operation, "name" | "meta">;
  /**
   * The arguments of the call being decided, such as a tool call's input. An
   * `approval-required` token binds their digest, so an approval covers this
   * call and no call with other arguments. Agent and MCP adapters pass the
   * tool arguments. Never read when deciding.
   */
  readonly args?: unknown;
  /**
   * The application's own data for the decision event (a request id, a
   * route). Plain JSON; a value that is not is dropped. Never read when
   * deciding.
   */
  readonly x?: AppData;
};

export type SimulateOptions = {
  /** Decision clock for the whole batch: grant validity, membership expiry and limits are read as of this instant. Defaults to the current time. */
  readonly now?: Instant;
};

export type RowPair<T> = {
  readonly current: T;
  readonly next: T;
};

export type WhereResult = {
  readonly condition:
    | Condition
    | { readonly op: "or"; readonly conditions: readonly [] };
  readonly partial: boolean;
  /**
   * The subject `where()` was built for. `toWhere` reads its memberships for
   * `memberOf` when no `subject` option is passed. Not enumerable, so it never
   * serialises with the result.
   */
  readonly subject?: Subject;
  /** The policy's scopes, for `memberOf`; not enumerable either. */
  readonly scopes?: readonly Scope[];
  /** The policy's resource graph, for `related`; not enumerable either. */
  readonly resources?: ReadonlyMap<string, ResourceNode>;
};

export type SnapshotOptions = {
  readonly include?: readonly (
    | Permission
    | { readonly [key: string]: unknown }
  )[];
  readonly tenants?: "all";
  readonly signer?: TokenSigner;
  readonly audience?: string | readonly string[];
};

export type PermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly can: {
    (
      permission: Permission<string, unknown, "instance">,
      data: unknown,
      options?: DecideOptions,
    ): boolean;
    (
      permission: Permission<string, unknown, "collection">,
      data?: unknown,
      options?: DecideOptions,
    ): boolean;
    /**
     * A permission held as `Permission` at run time (from a list, a catalog
     * or `findPermission`), whose kind the type does not say: pass `data`,
     * or `undefined` for a check without a row.
     */
    (permission: Permission, data: unknown, options?: DecideOptions): boolean;
  };
  readonly decide: {
    (
      permission: Permission<string, unknown, "instance">,
      data: unknown,
      options?: DecideOptions,
    ): Decision;
    (
      permission: Permission<string, unknown, "collection">,
      data?: unknown,
      options?: DecideOptions,
    ): Decision;
    /**
     * A permission held as `Permission` at run time (from a list, a catalog
     * or `findPermission`), whose kind the type does not say: pass `data`,
     * or `undefined` for a check without a row.
     */
    (permission: Permission, data: unknown, options?: DecideOptions): Decision;
  };
  /**
   * `decide` for each row, in row order. Each row is its own call: a limit
   * is consumed once per granted row, so rows past the cap are denied with
   * `limit`, and each `approval-required` row carries its own token.
   */
  readonly decideEach: (
    permission: Permission,
    rows: readonly unknown[],
    options?: DecideOptions,
  ) => readonly Decision[];
  /**
   * What `permission` on `row` decides for the principal `principalId`,
   * loaded from `principals` in this instance's active tenant with no actor
   * and no delegation. It grants this instance nothing, shares none of its
   * caches and never consumes a limit. Denied with `anonymous` when there is
   * no `principals`, no such principal or the source throws, and with
   * `tenant-mismatch` when the principal is outside the active tenant.
   */
  readonly decideFor: (
    principalId: string,
    permission: Permission,
    row?: unknown,
  ) => Promise<Decision>;
  readonly assert: {
    (
      permission: Permission<string, unknown, "instance">,
      data: unknown,
      options?: DecideOptions,
    ): Extract<Decision, { readonly outcome: "granted" }>;
    (
      permission: Permission<string, unknown, "collection">,
      data?: unknown,
      options?: DecideOptions,
    ): Extract<Decision, { readonly outcome: "granted" }>;
    /**
     * A permission held as `Permission` at run time (from a list, a catalog
     * or `findPermission`), whose kind the type does not say: pass `data`,
     * or `undefined` for a check without a row.
     */
    (
      permission: Permission,
      data: unknown,
      options?: DecideOptions,
    ): Extract<Decision, { readonly outcome: "granted" }>;
  };
  /**
   * `decide` with `explain: true`: the same decision, with a `trace` that
   * names the grants evaluated, the allows and denies that matched (so a
   * `denied` says which deny won) and the grants passed over. Local
   * computation only; the trace never reaches a `DecisionSink`.
   */
  readonly explain: {
    (
      permission: Permission<string, unknown, "instance">,
      data: unknown,
      options?: Omit<DecideOptions, "explain">,
    ): ExplainedDecision;
    (
      permission: Permission<string, unknown, "collection">,
      data?: unknown,
      options?: Omit<DecideOptions, "explain">,
    ): ExplainedDecision;
    (
      permission: Permission,
      data: unknown,
      options?: Omit<DecideOptions, "explain">,
    ): ExplainedDecision;
  };
  readonly filter: <T>(
    permission: Permission<string, T, "instance">,
    rows: readonly T[],
    options?: DecideOptions,
  ) => T[];
  readonly pick: <T>(
    permission: Permission<string, T, "instance">,
    row: T,
    options?: DecideOptions,
  ) => Partial<T>;
  readonly where: (permission: Permission) => WhereResult;
  readonly actions: (
    resource: Permission | { readonly [key: string]: unknown },
    data: unknown,
    options?: DecideOptions,
  ) => Permission[];
  readonly simulate: {
    (
      checks: readonly (readonly [Permission, unknown?])[],
      options?: SimulateOptions,
    ): Decision[];
    (preview: {
      readonly roles?: readonly (string | Role)[];
      readonly memberships?: readonly Membership[];
      readonly tenant?: string;
    }): PermDock<V>;
  };
  readonly snapshot: {
    (options?: SnapshotOptions & { readonly signer?: undefined }): Snapshot;
    (
      options: SnapshotOptions & { readonly signer: TokenSigner },
    ): Promise<string>;
    (options?: SnapshotOptions): Snapshot | Promise<string>;
  };
  readonly on: (
    event: "decision" | "denied" | "approval" | "auth" | "error",
    handler: (payload: unknown) => void,
  ) => () => void;
  readonly tenant: (id: string) => PermDock<V>;
  readonly team: (id: string) => PermDock<V>;
  readonly memberships: () => readonly Membership[];
  readonly tenants: () => readonly string[];
  /**
   * Roles held in a tenant (the active one by default), or only on the
   * memberships of one `scope` (and instance `id`). Ordered by rank: a role
   * comes before the roles its `assigns` lists.
   */
  readonly heldRoles: (options?: {
    readonly tenant?: string;
    readonly scope?: string;
    readonly id?: string;
  }) => readonly Role[];
  /** The distinct `meta.audience` values of the roles held in the active tenant, in rank order. */
  readonly audiences: () => readonly string[];
  /**
   * The roles the subject may hand out in a tenant (the active one by
   * default), or with `scope: 'global'` the global roles it may hand out. A
   * snapshot answers only the tenant form.
   */
  readonly assignableRoles: (options?: {
    readonly tenant?: string;
    readonly scope?: "global";
  }) => readonly Role[];
  /**
   * The custom-role ceiling the subject may hand out: in a tenant (empty
   * without one), or with `scope: 'global'` for platform custom roles, the
   * allows of assignable global roles the subject holds. A snapshot answers
   * only the tenant form.
   */
  readonly assignablePermissions: (options?: {
    readonly tenant?: string;
    readonly scope?: "global";
  }) => readonly Permission[];
  /**
   * The levels of `permission` (`resource(…, { levels })`) the subject may
   * hand out in a custom role: those it holds, or every level with
   * `meta.manageRoles`. Empty when the permission is not assignable.
   */
  readonly assignableLevels: (
    permission: Permission,
    options?: { readonly tenant?: string; readonly scope?: "global" },
  ) => readonly string[];
  /**
   * Whether `permission` could be granted to the subject for some row, within
   * its delegation. A listing hint for tools and skills, never a decision.
   */
  readonly mayUse: (permission: Permission) => boolean;
  /**
   * The instances of `scope` in which the subject holds `permission`, the
   * in-process mirror of the SQL `permitted_<scope>_ids_by_permission`. A
   * listing, never a decision: a row's own check still runs `can`.
   */
  readonly permittedIds: (
    permission: Permission,
    scope: string,
    options?: PermittedIdsOptions,
  ) => readonly string[];
  /**
   * Loads the relation facts `permission` needs for `rows` into this
   * instance's cache, so `can`, `decide` and `filter` answer synchronously
   * over an async `RelationSource`. It never grants; a failed load leaves
   * the checks denied with `relation-unavailable`.
   */
  readonly loadRelations: (
    permission: Permission,
    rows: readonly unknown[],
  ) => Promise<void>;
  readonly roles: V["roles"] extends RoleTree ? V["roles"] : RoleTree;
  readonly plans: V["plans"] extends PlanTree ? V["plans"] : PlanTree;
  readonly permissions: V["permissions"] extends Policy["permissions"]
    ? V["permissions"]
    : Policy["permissions"];
  readonly subject: Subject;
  /**
   * The same subject, tenant, team, actor, delegation, sink and limits with
   * other sources: `customRoles`, `approvalPolicies` or `relations`. The
   * sources it names are read again for the subject's tenants; the others
   * keep what this instance loaded. Always a promise, since the sources it
   * names may answer asynchronously.
   */
  readonly derive: (options: DeriveOptions) => Promise<PermDock<V>>;
};

/** What `permdock.derive` may replace: the sources read after the subject is resolved. */
export type DeriveOptions = Pick<
  PermDockOptions,
  "customRoles" | "approvalPolicies" | "relations" | "principals"
>;

export type PermDockOptions = {
  readonly tenant?: string;
  /** One source, or several composed with `composeMemberships`. */
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  readonly customRoles?: CustomRoleSource | CustomRoleSourceFactory;
  /** Plans and seats from billing, merged into `principal.plans` for the active tenant. */
  readonly entitlements?: EntitlementSource;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly sink?: DecisionSink;
  /** Grant limits, `limits(store)`; without it a grant with a `limit` denies with `limit-unavailable`. */
  readonly limits?: Limits;
  readonly session?: string;
  readonly expiresAt?: number;
  /** Hosted grants, `hostedPolicies(source)`; `current()` is read once, when the instance is created. */
  readonly policies?: HostedPolicies;
  /** The object graph for `through` and edge-table relations; without it they deny with `relation-unavailable`. */
  readonly relations?: RelationSource;
  /** Approval requirements kept as data; they add to the code's and never remove one. A throw denies. */
  readonly approvalPolicies?: ApprovalPolicies;
  /** Other principals by id, for `decideFor`; asked with the active tenant. */
  readonly principals?: PrincipalSource;
  /** Tenant settings, read by `decideCredential` for the key's tenant; a call's own `settings` wins. */
  readonly settings?: SettingsSource;
  /**
   * Request values an adapter's `context` hook derived on the server, merged
   * into `subject.context`; keys from `policy.context` win on a clash.
   */
  readonly context?: Readonly<Record<string, unknown>>;
};

function instantiate(
  codePolicy: Policy,
  subject: Subject,
  options: PermDockOptions,
  auth: AuthEvent[],
): PermDock | Promise<PermDock> {
  const { policy, errors } = options.policies?.apply(codePolicy) ?? {
    policy: codePolicy,
    errors: [],
  };
  const scopes = scopeList(policy.scopes);
  const tenants = tenantsOf(subject.principal, scopes);
  const roleSource = roleSourceFor(options.customRoles, subject, auth);
  const customRoles = customRolesFor(
    roleSource,
    tenants,
    auth,
    subject.principal === null ? undefined : (subject.principal.roles ?? []),
    (tenant) => heldRoleNamesIn(subject.principal, scopes, tenant),
  );
  const assignable = assignableNamesFor(roleSource, tenants, auth);
  const approvals = options.approvalPolicies?.load(policy, tenants, auth);
  const build = (
    roles: readonly CustomRole[],
    names: ReadonlyMap<string, readonly string[]> | undefined,
    approvalPolicies: LoadedApprovalPolicies | undefined,
  ): PermDock =>
    buildInstance(
      policy,
      subject,
      compact<InstanceEnv>({
        customRoles: roles,
        sink: options.sink,
        limits: options.limits,
        limitCache: new Map<string, number>(),
        simulated: false,
        roleSource,
        assignable: names,
        queuedAuth: auth,
        queuedErrors: errors,
        relations: options.relations,
        approvalPolicies,
        memberships:
          options.memberships === undefined
            ? undefined
            : asMembershipSource(options.memberships),
        principals: options.principals,
        settings: options.settings,
        targets: (principal: Principal, tenant: string | undefined) =>
          loadPermDock(
            codePolicy,
            { principal, context: {} },
            compact<PermDockOptions>({
              tenant,
              memberships: options.memberships,
              customRoles: options.customRoles,
              entitlements: options.entitlements,
              limits: options.limits,
              policies: options.policies,
              relations: options.relations,
              approvalPolicies: options.approvalPolicies,
            }),
          ),
      }),
    );
  if (
    isThenable(customRoles) ||
    isThenable(assignable) ||
    isThenable(approvals)
  ) {
    return Promise.all([customRoles, assignable, approvals]).then(
      ([roles, names, loaded]) => build(roles, names, loaded),
    );
  }
  return build(customRoles, assignable, approvals);
}

function create<
  TUser,
  TPrincipal extends Principal,
  V extends PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  user: TUser | Subject | null,
  given: PermDockOptions,
): PermDock<V> | Promise<PermDock<V>> {
  const options = withApp(policy, given);
  const auth: AuthEvent[] = [];
  const subject = resolveSubject(policy, user, options, auth);
  if (isThenable(subject)) {
    // SAFETY: instantiate builds the instance from this policy, whose vocabulary type is V.
    return subject.then((resolved) =>
      instantiate(policy, resolved, options, auth),
    ) as Promise<PermDock<V>>;
  }
  // SAFETY: instantiate builds the instance from this policy, whose vocabulary type is V.
  return instantiate(policy, subject, options, auth) as PermDock<V>;
}

/**
 * The instance for `user`, built synchronously. Every input must answer
 * synchronously: the subject mapper, `memberships`, `customRoles`,
 * `entitlements`, `approvalPolicies` and the freshness check. One that
 * answers with a Promise throws here; use `loadPermDock` for those.
 */
export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  user: TUser | Subject | null,
  options: PermDockOptions = {},
): PermDock<V> {
  const created = create(policy, user, options);
  if (isThenable(created)) {
    // The sources already ran; keep their failure from surfacing as an unhandled rejection.
    created.then(undefined, () => undefined);
    throw new Error(
      "PermDock: createPermDock got a Promise from the subject mapper or a source (memberships, customRoles, entitlements, approvalPolicies); use loadPermDock for asynchronous inputs",
    );
  }
  return created;
}

/** `createPermDock` for inputs that answer asynchronously: waits for every source, then builds the instance. */
export function loadPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  user: TUser | Subject | null,
  options: PermDockOptions = {},
): Promise<PermDock<V>> {
  // Through `then`, so a mapper or source that throws rejects instead of throwing.
  return Promise.resolve().then(() => create(policy, user, options));
}

export { fromSnapshot } from "./from-snapshot.ts";
export { parseSnapshot };
