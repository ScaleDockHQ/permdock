import type { Condition } from '../conditions/ast.ts';
import type { ArazzoPlan, ArazzoSimulateInput } from './arazzo.ts';
import type { Decision } from './decision.ts';
import type {
  AuthEvent,
  DecisionEvent,
  DecisionSink,
  LimitStore,
  MembershipSource,
  RoleSource,
  Snapshot,
  TokenSigner,
} from './interfaces.ts';
import type { Permission } from './permissions.ts';
import type { Policy, PolicyVocabulary } from './policy.ts';
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

import { describe } from './describe.ts';
import { customRolesFor } from './evaluate.ts';
import { buildInstance } from './instance.ts';
import { resolveSubject } from './resolve-subject.ts';
import { parseSnapshot } from './snapshot.ts';
import { tenantsOf } from './tenancy.ts';
import { isThenable } from './thenable.ts';

export type DecideOptions = {
  readonly trusted?: boolean;
  readonly boundary?: Boundary;
  readonly now?: number;
  readonly source?: DecisionEvent['source'];
  readonly adapter?: string;
  readonly onDenied?: (decision: Decision) => never | void;
  readonly field?: string;
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
    (checks: readonly (readonly [Permission, unknown?])[]): Decision[];
    (preview: {
      readonly roles?: readonly (string | Role)[];
      readonly memberships?: readonly Membership[];
      readonly tenant?: string;
    }): PermDock;
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
  readonly tenant: (id: string) => PermDock;
  readonly team: (id: string) => PermDock;
  readonly memberships: () => readonly Membership[];
  readonly tenants: () => readonly string[];
  readonly heldRoles: (options?: {
    readonly tenant?: string;
  }) => readonly Role[];
  readonly assignableRoles: () => readonly Role[];
  readonly roles: V['roles'] extends RoleTree ? V['roles'] : RoleTree;
  readonly plans: V['plans'] extends PlanTree ? V['plans'] : PlanTree;
  readonly permissions: V['permissions'] extends Policy['permissions']
    ? V['permissions']
    : Policy['permissions'];
  readonly subject: Subject;
};

export type CreatePermDockOptions = {
  readonly tenant?: string;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  readonly session?: string;
  readonly expiresAt?: number;
};

function instantiate(
  policy: Policy,
  subject: Subject,
  options: CreatePermDockOptions,
  auth: AuthEvent[],
): PermDock | Promise<PermDock> {
  const tenants = tenantsOf(subject.principal);
  const customRoles = customRolesFor(options.customRoles, tenants, auth);
  const build = (roles: readonly CustomRole[]): PermDock =>
    buildInstance(policy, subject, {
      customRoles: roles,
      sink: options.sink,
      limits: options.limits,
      limitCache: new Map<string, number>(),
      simulated: false,
      roleSource: options.customRoles,
      queuedAuth: auth,
    });
  if (isThenable(customRoles)) {
    return customRoles.then(build);
  }
  return build(customRoles);
}

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  user: TUser | Subject | null,
  options: CreatePermDockOptions = {},
): PermDock<V> | Promise<PermDock<V>> {
  const auth: AuthEvent[] = [];
  const subject = resolveSubject(policy, user, options, auth);
  if (isThenable(subject)) {
    return subject.then((resolved) =>
      instantiate(policy, resolved, options, auth),
    ) as Promise<PermDock<V>>;
  }
  return instantiate(policy, subject, options, auth) as PermDock<V>;
}

export { fromSnapshot } from './from-snapshot.ts';
export { describe, parseSnapshot };
