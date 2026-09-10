import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { DecisionProvider } from './interfaces.ts';
import type { Principal } from './subject.ts';

import {
  type Condition,
  type WhereShorthand,
  normalizeWhere,
} from '../conditions/index.ts';
import { compact } from './compact.ts';
import { sanitizeFields } from './fields.ts';
import { freezeDeep } from './freeze.ts';
import {
  type Grantee,
  type GranteeInput,
  asGrantee,
  flattenGrantee,
  roleNameOf,
  roleScopeOf,
} from './grantee.ts';
import {
  type Permission,
  type PermissionKind,
  type PermissionTree,
  type ResourceNode,
  getRegistry,
  isRegistryTree,
  listPermissions,
} from './permissions.ts';
import { sha256, bytesToBase64Url } from './sha256.ts';
import {
  type PlanTree,
  type Role as RoleLeaf,
  type RoleTree,
  isRole,
  listRoles,
} from './vocabulary.ts';

export const NON_PORTABLE: unique symbol = Symbol.for('permdock.non-portable');

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

export type NonPortable<T> = T & { readonly [NON_PORTABLE]: true };

export type GrantOptions<T = Record<string, unknown>> = {
  readonly to?: GranteeInput;
  readonly where?: WhereShorthand<T> | Condition;
  readonly check?: WhereShorthand<T> | Condition;
  readonly approval?: 'human';
  readonly limit?: { readonly count: number; readonly per: string };
  readonly reason?: string;
  readonly fields?: readonly (keyof T & string)[];
};

export type RoleScope =
  | 'tenant'
  | 'team'
  | Permission
  | PermissionTree
  | readonly (Permission | PermissionTree)[];

export type RoleOptions = {
  readonly on?: RoleScope;
  readonly assignable?: boolean;
};

export type Grant = {
  readonly permission: Permission;
  readonly effect: 'allow' | 'deny';
  readonly to: Grantee | readonly Grantee[];
  readonly role: string | null;
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: 'human';
  readonly portable: boolean;
  readonly closure?: ClosureGrantFn;
  readonly limit?: { readonly count: number; readonly per: string };
  readonly fields?: readonly string[];
  readonly scope: 'global' | 'tenant' | 'team' | { readonly resource: string };
};

export type RoleBinding = {
  readonly name: string;
  readonly grants: readonly Grant[];
  readonly on?: RoleScope;
  readonly assignable: boolean;
};

/** @deprecated Use `RoleBinding` for grant lists and `Role` from vocabulary for leaves. */
export type Role = RoleBinding;

export type ValidateMode = 'boundary' | 'always' | 'never';

export type PolicyScopes = {
  readonly tenant?: { readonly key: string };
  readonly team?: { readonly key: string };
};

export type PolicyVocabulary = {
  readonly permissions: PermissionTree;
  readonly roles?: RoleTree;
  readonly plans?: PlanTree;
};

type VocabularyFromInput<Input> = Input extends PolicyVocabulary
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
> = {
  readonly permissions: V['permissions'];
  readonly roles: readonly RoleBinding[];
  readonly rolesByName: ReadonlyMap<string, RoleBinding>;
  readonly grants: readonly Grant[];
  readonly vocabulary: V;
  readonly scopes: PolicyScopes;
  principal(user: TUser): TPrincipal | null;
  subject(user: TUser): TPrincipal | null;
  context?(
    user: TUser,
  ):
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  readonly validate: ValidateMode;
  readonly onDenied?: (decision: unknown) => never | void;
  readonly fingerprint: string;
  readonly resources: ReadonlyMap<string, ResourceNode>;
  readonly providers?: readonly DecisionProvider[];
};

function isClosure(value: unknown): value is ClosureGrantFn {
  return typeof value === 'function';
}

function isPermission(value: unknown): value is Permission {
  return (
    value !== null &&
    typeof value === 'object' &&
    'key' in value &&
    'kind' in value &&
    'action' in value
  );
}

function flattenPermissions(
  input: Permission | readonly Permission[] | PermissionTree,
): Permission[] {
  if (isPermission(input)) {
    return [input];
  }
  if (Array.isArray(input)) {
    return input.flatMap((item) => flattenPermissions(item));
  }
  return [...listPermissions(input as PermissionTree)];
}

function resolveRoleScope(on: RoleScope | undefined): Grant['scope'] {
  if (on === undefined) {
    return 'global';
  }
  if (on === 'tenant' || on === 'team') {
    return on;
  }
  const permissions = flattenPermissions(
    on as Permission | PermissionTree | readonly Permission[],
  );
  const names = new Set(permissions.map((permission) => permission.resource));
  if (names.size !== 1) {
    throw new Error(
      'PermDock: role on: resource must name exactly one resource',
    );
  }
  return { resource: [...names][0]! };
}

function makeGrant(
  permission: Permission,
  effect: 'allow' | 'deny',
  condition: GrantOptions | ClosureGrantFn | undefined,
): Omit<Grant, 'role' | 'scope'> {
  const toInput = isClosure(condition) ? undefined : condition?.to;
  const to =
    toInput === undefined
      ? ({
          kind: 'role',
          role: '',
          scope: 'global',
        } satisfies Grantee)
      : asGrantee(toInput);
  if (isClosure(condition)) {
    return {
      permission,
      effect,
      to,
      portable: false,
      closure: condition,
    };
  }
  const whereInput = condition?.where;
  const checkInput = condition?.check;
  if (whereInput !== undefined && permission.kind === 'collection') {
    throw new Error(
      `PermDock: where is not allowed on collection action '${permission.key}'`,
    );
  }
  const where =
    whereInput === undefined ? undefined : normalizeWhere(whereInput);
  const check =
    checkInput === undefined ? undefined : normalizeWhere(checkInput);
  const portable = condition?.limit === undefined;
  return compact<Omit<Grant, 'role' | 'scope'>>({
    permission,
    effect,
    to,
    where,
    check,
    approval: condition?.approval,
    portable,
    limit: condition?.limit,
    fields: sanitizeFields(condition?.fields),
  });
}

export type GrantCondition<T, K extends PermissionKind> = K extends 'collection'
  ? Omit<GrantOptions<T>, 'where' | 'fields'> | ClosureGrantFn<T>
  : GrantOptions<T> | ClosureGrantFn<T>;

export function allow<T, K extends PermissionKind = PermissionKind>(
  permission: Permission<string, T, K> | readonly Permission<string, T, K>[],
  condition?: GrantCondition<T, K>,
): Omit<Grant, 'role' | 'scope'> | Omit<Grant, 'role' | 'scope'>[] {
  const permissions = flattenPermissions(permission);
  const grants = permissions.map((leaf) =>
    makeGrant(
      leaf,
      'allow',
      condition as GrantOptions | ClosureGrantFn | undefined,
    ),
  );
  return grants.length === 1 ? grants[0]! : grants;
}

export function deny<T, K extends PermissionKind = PermissionKind>(
  permission: Permission<string, T, K> | readonly Permission<string, T, K>[],
  condition?: GrantCondition<T, K>,
): Omit<Grant, 'role' | 'scope'> | Omit<Grant, 'role' | 'scope'>[] {
  const permissions = flattenPermissions(permission);
  const grants = permissions.map((leaf) =>
    makeGrant(
      leaf,
      'deny',
      condition as GrantOptions | ClosureGrantFn | undefined,
    ),
  );
  return grants.length === 1 ? grants[0]! : grants;
}

function flattenGrants(
  grants: readonly (
    | Omit<Grant, 'role' | 'scope'>
    | readonly Omit<Grant, 'role' | 'scope'>[]
  )[],
): Omit<Grant, 'role' | 'scope'>[] {
  const out: Omit<Grant, 'role' | 'scope'>[] = [];
  for (const grant of grants) {
    if (Array.isArray(grant)) {
      out.push(...(grant as readonly Omit<Grant, 'role' | 'scope'>[]));
    } else {
      out.push(grant as Omit<Grant, 'role' | 'scope'>);
    }
  }
  return out;
}

export function role(
  name: string | RoleLeaf,
  grants: readonly (
    | Omit<Grant, 'role' | 'scope'>
    | readonly Omit<Grant, 'role' | 'scope'>[]
  )[],
  options?: RoleOptions,
): RoleBinding {
  const leaf = isRole(name) ? name : undefined;
  const roleName = leaf?.key ?? (name as string);
  const scope = resolveRoleScope(options?.on ?? leaf?.on);
  const assignable =
    options?.assignable ?? leaf?.assignable ?? scope !== 'global';
  const roleGrantee = asGrantee(
    leaf ??
      freezeDeep({
        kind: 'role' as const,
        role: roleName,
        scope,
      }),
  );
  const normalised = flattenGrants(grants).map((grant) => {
    const items = flattenGrantee(grant.to);
    const first = items[0];
    const roleTo =
      items.length === 1 && first !== undefined && first.kind === 'role';
    const to = roleTo ? roleGrantee : grant.to;
    return freezeDeep({
      ...grant,
      to,
      role: roleName,
      scope: roleScopeOf(to, scope),
    });
  });
  return freezeDeep(
    compact<RoleBinding>({
      name: roleName,
      grants: normalised,
      on: options?.on ?? leaf?.on,
      assignable,
    }),
  );
}

function canonicalGrants(grants: readonly Grant[]): string {
  const payload = grants.map((grant) => ({
    permission: grant.permission.key,
    effect: grant.effect,
    to: grant.to,
    role: grant.role,
    where: grant.where,
    check: grant.check,
    approval: grant.approval,
    portable: grant.portable,
    fields: grant.fields,
    scope: grant.scope,
  }));
  return JSON.stringify(payload);
}

function assertParentGraph(resources: ReadonlyMap<string, ResourceNode>): void {
  for (const node of resources.values()) {
    if (node.parent === undefined) {
      continue;
    }
    if (!resources.has(node.parent.resource)) {
      throw new Error(
        `PermDock: resource '${node.name}' parents unknown resource '${node.parent.resource}'`,
      );
    }
  }
}

function assertScopedResources(
  grants: readonly Grant[],
  scopes: PolicyScopes,
  resources: ReadonlyMap<string, ResourceNode>,
): void {
  const needsTenant = grants.some((grant) => grant.scope === 'tenant');
  const needsTeam = grants.some((grant) => grant.scope === 'team');
  if (needsTenant && scopes.tenant === undefined) {
    throw new Error(
      "PermDock: definePolicy({ scopes.tenant }) is required for on: 'tenant' roles",
    );
  }
  if (needsTeam && scopes.team === undefined) {
    throw new Error(
      "PermDock: definePolicy({ scopes.team }) is required for on: 'team' roles",
    );
  }
  void resources;
}

function isVocabularyInput(value: unknown): value is PolicyVocabulary {
  return (
    value !== null &&
    typeof value === 'object' &&
    'permissions' in value &&
    isRegistryTree((value as PolicyVocabulary).permissions)
  );
}

function completeGrant(grant: Omit<Grant, 'role' | 'scope'>): Grant {
  const to = flattenGrantee(grant.to);
  const first = to[0];
  const placeholder =
    to.length === 1 &&
    first !== undefined &&
    first.kind === 'role' &&
    first.role === '';
  if (placeholder) {
    throw new Error('PermDock: grant is missing to');
  }
  return freezeDeep({
    ...grant,
    role: roleNameOf(grant.to),
    scope: roleScopeOf(grant.to),
  });
}

function mergeBindings(items: readonly RoleBinding[]): {
  readonly roles: readonly RoleBinding[];
  readonly rolesByName: Map<string, RoleBinding>;
} {
  const merged = new Map<string, RoleBinding>();
  for (const item of items) {
    const existing = merged.get(item.name);
    if (existing === undefined) {
      merged.set(item.name, item);
      continue;
    }
    merged.set(
      item.name,
      freezeDeep(
        compact<RoleBinding>({
          name: item.name,
          grants: [...existing.grants, ...item.grants],
          on: existing.on,
          assignable: existing.assignable,
        }),
      ),
    );
  }
  return { roles: [...merged.values()], rolesByName: merged };
}

export type DefinePolicyOptions<TUser, TPrincipal extends Principal> = {
  readonly roles?: readonly RoleBinding[];
  readonly grants?: readonly (
    | Omit<Grant, 'role' | 'scope'>
    | readonly Omit<Grant, 'role' | 'scope'>[]
    | Grant
  )[];
  readonly scopes?: PolicyScopes;
  readonly principal?: (user: TUser) => TPrincipal | null;
  readonly subject?: (user: TUser) => TPrincipal | null;
  readonly context?: (
    user: TUser,
  ) =>
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  readonly validate?: ValidateMode;
  readonly onDenied?: (decision: unknown) => never | void;
  readonly providers?: readonly DecisionProvider[];
};

export function definePolicy<
  TUser,
  TPrincipal extends Principal,
  const Input extends PermissionTree | PolicyVocabulary,
>(
  permissions: Input,
  options: DefinePolicyOptions<TUser, TPrincipal>,
): Policy<TUser, TPrincipal, VocabularyFromInput<Input>> {
  const vocabulary = (
    isVocabularyInput(permissions)
      ? permissions
      : { permissions: permissions as PermissionTree }
  ) as VocabularyFromInput<Input>;
  const tree = vocabulary.permissions;
  const mapper = options.principal ?? options.subject;
  if (mapper === undefined) {
    throw new Error('PermDock: definePolicy requires principal or subject');
  }
  const resources = getRegistry(tree);
  assertParentGraph(resources);
  const { roles, rolesByName } = mergeBindings(options.roles ?? []);
  const declared = new Set(roles.map((item) => item.name));
  for (const leaf of listRoles(vocabulary.roles)) {
    declared.add(leaf.key);
  }
  const fromBindings = roles.flatMap((item) => item.grants);
  const fromGrants = flattenGrants(
    (options.grants ?? []) as readonly (
      | Omit<Grant, 'role' | 'scope'>
      | readonly Omit<Grant, 'role' | 'scope'>[]
    )[],
  ).map(completeGrant);
  const grants = [...fromBindings, ...fromGrants];
  const scopes = options.scopes ?? {};
  assertScopedResources(grants, scopes, resources);
  const fingerprint = bytesToBase64Url(sha256(canonicalGrants(grants)));
  return freezeDeep({
    permissions: tree,
    roles,
    rolesByName,
    grants,
    vocabulary,
    scopes,
    principal: mapper,
    subject: mapper,
    context: options.context,
    validate: options.validate ?? 'boundary',
    onDenied: options.onDenied,
    fingerprint,
    resources,
    providers: options.providers,
  }) as Policy<TUser, TPrincipal, VocabularyFromInput<Input>>;
}

export type PrincipalOf<P> =
  P extends Policy<unknown, infer TPrincipal> ? TPrincipal : Principal;

export type SubjectOf<P> = {
  readonly principal: PrincipalOf<P> | null;
  readonly actor?: import('./subject.ts').Actor;
  readonly delegation?: import('./subject.ts').Delegation;
  readonly context: Readonly<Record<string, unknown>>;
  readonly session?: string;
  readonly expiresAt?: number;
};

export function inferOutput<T>(
  schema: StandardSchemaV1<unknown, T> | undefined,
): T | undefined {
  return schema as unknown as T | undefined;
}
