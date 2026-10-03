import type { Condition } from '../conditions/ast.ts';
import type { ArazzoPlan, ArazzoSimulateInput } from './arazzo.ts';
import type { Decision, ExplainedDecision } from './decision.ts';
import type { ActivateInput } from './elevated.ts';
import type {
  AuthEvent,
  DecisionEvent,
  DecisionSink,
  LimitStore,
  EntitlementSource,
  MembershipSource,
  RelationSource,
  RoleSource,
  Snapshot,
  TokenSigner,
} from './interfaces.ts';
import type {
  RoleChange,
  RoleChangeDecision,
  RoleChangeOptions,
} from './ownership.ts';
import type { Permission, ResourceNode } from './permissions.ts';
import type { Policy, PolicyVocabulary } from './policy.ts';
import type { Scope } from './scopes.ts';
import type {
  Actor,
  CustomRole,
  Delegation,
  Membership,
  Principal,
  Subject,
} from './subject.ts';
import type { Boundary } from './validation.ts';
import type { PlanTree, Role, RoleTree } from './vocabulary.ts';
import type { WhoCan } from './who-can.ts';

import { compact } from './compact.ts';
import { assignableNamesFor, customRolesFor } from './evaluate.ts';
import {
  type PolicyDocument,
  type PolicySource,
  mergeHostedGrants,
} from './hosted.ts';
import { buildInstance } from './instance.ts';
import { asMembershipSource } from './memberships.ts';
import { resolveSubject } from './resolve-subject.ts';
import { scopeList } from './scopes.ts';
import { parseSnapshot } from './snapshot.ts';
import { tenantsOf } from './tenancy.ts';
import { isThenable } from './thenable.ts';

export type DecideOptions = {
  /** `true` skips schema validation for a row the server loaded itself. Otherwise `data` is validated against the resource schema first (`validate: 'boundary'`), and a failure denies with reason `validation`. */
  readonly trusted?: boolean;
  /** Where untrusted data came from, reported on validation errors. Defaults to `'manual'`. */
  readonly boundary?: Boundary;
  /** Decision clock in Unix seconds, for expiries and limits. Defaults to the current time. */
  readonly now?: number;
  /** The call that produced the decision, reported on the decision event. Defaults to `'decide'`. */
  readonly source?: DecisionEvent['source'];
  /** The adapter that made the call, reported on the decision event. */
  readonly adapter?: string;
  /** Per-call unauthorized handler for `assert`; runs before instance and policy handlers. */
  readonly onDenied?: (decision: Decision) => never | void;
  /** The field being read or written; only grants whose `fields` cover it match. */
  readonly field?: string;
  /** `true` attaches a `trace` to the decision: the grants evaluated, matched and skipped. Off by default and free when off. */
  readonly explain?: boolean;
};

export type SimulateOptions = {
  /** Decision clock in Unix seconds for the whole batch: grant validity, membership expiry and limits are read as of this instant. Defaults to the current time. */
  readonly now?: number;
};

export type RowPair<T> = {
  readonly current: T;
  readonly next: T;
};

export type WhereResult = {
  readonly condition:
    | Condition
    | { readonly op: 'or'; readonly conditions: readonly [] };
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

export type PermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly can: {
    (
      permission: Permission<string, unknown, 'instance'>,
      data: unknown,
      options?: DecideOptions,
    ): boolean;
    (
      permission: Permission<string, unknown, 'collection'>,
      data?: unknown,
      options?: DecideOptions,
    ): boolean;
  };
  readonly decide: {
    (
      permission: Permission<string, unknown, 'instance'>,
      data: unknown,
      options?: DecideOptions,
    ): Decision;
    (
      permission: Permission<string, unknown, 'collection'>,
      data?: unknown,
      options?: DecideOptions,
    ): Decision;
  };
  readonly assert: {
    (
      permission: Permission<string, unknown, 'instance'>,
      data: unknown,
      options?: DecideOptions,
    ): Extract<Decision, { readonly outcome: 'granted' }>;
    (
      permission: Permission<string, unknown, 'collection'>,
      data?: unknown,
      options?: DecideOptions,
    ): Extract<Decision, { readonly outcome: 'granted' }>;
  };
  /**
   * `decide` with `explain: true`: the same decision, with a `trace` that
   * names the grants evaluated, the allows and denies that matched (so a
   * `denied` says which deny won) and the grants passed over. Local
   * computation only; the trace never reaches a `DecisionSink`.
   */
  readonly explain: {
    (
      permission: Permission<string, unknown, 'instance'>,
      data: unknown,
      options?: Omit<DecideOptions, 'explain'>,
    ): ExplainedDecision;
    (
      permission: Permission<string, unknown, 'collection'>,
      data?: unknown,
      options?: Omit<DecideOptions, 'explain'>,
    ): ExplainedDecision;
  };
  readonly filter: <T>(
    permission: Permission<string, T, 'instance'>,
    rows: readonly T[],
    options?: DecideOptions,
  ) => T[];
  readonly pick: <T>(
    permission: Permission<string, T, 'instance'>,
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
    (plan: ArazzoSimulateInput): ArazzoPlan;
  };
  readonly snapshot: (options?: {
    readonly include?: readonly (
      | Permission
      | { readonly [key: string]: unknown }
    )[];
    readonly tenants?: 'all';
    readonly signer?: TokenSigner;
    readonly audience?: string | readonly string[];
  }) => Snapshot | Promise<string>;
  readonly on: (
    event: 'decision' | 'denied' | 'approval' | 'auth' | 'error',
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
  readonly assignableRoles: (options?: {
    readonly tenant?: string;
  }) => readonly Role[];
  /** The tenant custom-role ceiling the subject may hand out; empty without a tenant. */
  readonly assignablePermissions: (options?: {
    readonly tenant?: string;
  }) => readonly Permission[];
  /**
   * Whether the subject may assign, revoke or transfer a role in one scope
   * instance: `assigns`, the ceiling, `for`, `exclusiveWith`, `min`, `max`
   * and `transferOnly`. It never writes; the application does, and generated
   * RLS triggers re-check the holder counts at commit. A nested instance's
   * tenant comes from a live membership the subject holds on it, or from
   * `change.within` only with `{ trusted: true }`; otherwise `no-membership`.
   */
  readonly decideRoleChange: (
    change: RoleChange,
    options?: RoleChangeOptions,
  ) => RoleChangeDecision;
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
  /**
   * Who holds `permission` on `resource` and how (role, relation or share),
   * from `MembershipSource.list` and `RelationSource.related`. It lists and
   * never grants; `complete: false` means some holders could not be listed.
   */
  readonly whoCan: (
    permission: Permission<string, unknown, 'instance'>,
    resource: unknown,
  ) => Promise<WhoCan>;
  /**
   * Requests a just-in-time activation of an eligible role. It never writes:
   * a granted decision carries the elevated membership under `elevation` for
   * the app to write, and `approval-required` comes back first when the
   * role's `activation` sets `approval`.
   */
  readonly activate: (input: ActivateInput) => Decision;
  readonly roles: V['roles'] extends RoleTree ? V['roles'] : RoleTree;
  readonly plans: V['plans'] extends PlanTree ? V['plans'] : PlanTree;
  readonly permissions: V['permissions'] extends Policy['permissions']
    ? V['permissions']
    : Policy['permissions'];
  readonly subject: Subject;
};

export type PermDockOptions = {
  readonly tenant?: string;
  /** One source, or several composed with `composeMemberships`. */
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  readonly customRoles?: RoleSource;
  /** Plans and seats from billing, merged into `principal.plans` for the active tenant. */
  readonly entitlements?: EntitlementSource;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  readonly session?: string;
  readonly expiresAt?: number;
  /** Hosted grants; `current()` is read once, when the instance is created. */
  readonly policies?: PolicySource;
  /** The object graph for `through` and edge-table relations; without it they deny with `relation-unavailable`. */
  readonly relations?: RelationSource;
};

function hostedPolicy(
  policy: Policy,
  source: PolicySource | undefined,
): { readonly policy: Policy; readonly errors: readonly unknown[] } {
  if (source === undefined || policy.hostable.length === 0) {
    return { policy, errors: [] };
  }
  let document: PolicyDocument | null;
  try {
    document = source.current();
  } catch (error) {
    return { policy, errors: [error] };
  }
  const merged = mergeHostedGrants(policy, document);
  return { policy: merged.policy, errors: merged.dropped };
}

function instantiate(
  codePolicy: Policy,
  subject: Subject,
  options: PermDockOptions,
  auth: AuthEvent[],
): PermDock | Promise<PermDock> {
  const { policy, errors } = hostedPolicy(codePolicy, options.policies);
  const tenants = tenantsOf(subject.principal, scopeList(policy.scopes));
  const customRoles = customRolesFor(options.customRoles, tenants, auth);
  const assignable = assignableNamesFor(options.customRoles, tenants, auth);
  const build = (
    roles: readonly CustomRole[],
    names: ReadonlyMap<string, readonly string[]> | undefined,
  ): PermDock =>
    buildInstance(
      policy,
      subject,
      compact<Parameters<typeof buildInstance>[2]>({
        customRoles: roles,
        sink: options.sink,
        limits: options.limits,
        limitCache: new Map<string, number>(),
        simulated: false,
        roleSource: options.customRoles,
        assignable: names,
        queuedAuth: auth,
        queuedErrors: errors,
        relations: options.relations,
        memberships:
          options.memberships === undefined
            ? undefined
            : asMembershipSource(options.memberships),
      }),
    );
  if (isThenable(customRoles) || isThenable(assignable)) {
    return Promise.all([customRoles, assignable]).then(([roles, names]) =>
      build(roles, names),
    );
  }
  return build(customRoles, assignable);
}

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  user: TUser | Subject | null,
  options: PermDockOptions = {},
): PermDock<V> | Promise<PermDock<V>> {
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

export { fromSnapshot } from './from-snapshot.ts';
export { parseSnapshot };
