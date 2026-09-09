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
  type Permission,
  type PermissionKind,
  type PermissionTree,
  type ResourceNode,
  getRegistry,
  listPermissions,
} from './permissions.ts';
import { sha256, bytesToBase64Url } from './sha256.ts';

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
  readonly role: string;
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: 'human';
  readonly portable: boolean;
  readonly closure?: ClosureGrantFn;
  readonly limit?: { readonly count: number; readonly per: string };
  readonly fields?: readonly string[];
  readonly scope: 'global' | 'tenant' | 'team' | { readonly resource: string };
};

export type Role = {
  readonly name: string;
  readonly grants: readonly Grant[];
  readonly on?: RoleScope;
  readonly assignable: boolean;
};

export type ValidateMode = 'boundary' | 'always' | 'never';

export type PolicyScopes = {
  readonly tenant?: { readonly key: string };
  readonly team?: { readonly key: string };
};

export type Policy<
  TUser = unknown,
  TPrincipal extends Principal = Principal,
> = {
  readonly permissions: PermissionTree;
  readonly roles: readonly Role[];
  readonly rolesByName: ReadonlyMap<string, Role>;
  readonly scopes: PolicyScopes;
  readonly subject: (user: TUser) => TPrincipal | null;
  readonly context?: (
    user: TUser,
  ) =>
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
  if (isClosure(condition)) {
    return {
      permission,
      effect,
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
  name: string,
  grants: readonly (
    | Omit<Grant, 'role' | 'scope'>
    | readonly Omit<Grant, 'role' | 'scope'>[]
  )[],
  options?: RoleOptions,
): Role {
  const scope = resolveRoleScope(options?.on);
  const assignable = options?.assignable ?? scope !== 'global';
  const normalised = flattenGrants(grants).map((grant) =>
    freezeDeep({
      ...grant,
      role: name,
      scope,
    }),
  );
  return freezeDeep(
    compact<Role>({
      name,
      grants: normalised,
      on: options?.on,
      assignable,
    }),
  );
}

function canonicalGrants(roles: readonly Role[]): string {
  const payload = roles.map((item) => ({
    name: item.name,
    assignable: item.assignable,
    scope: item.grants[0]?.scope ?? 'global',
    grants: item.grants.map((grant) => ({
      permission: grant.permission.key,
      effect: grant.effect,
      where: grant.where,
      check: grant.check,
      approval: grant.approval,
      portable: grant.portable,
      fields: grant.fields,
      scope: grant.scope,
    })),
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
  roles: readonly Role[],
  scopes: PolicyScopes,
  resources: ReadonlyMap<string, ResourceNode>,
): void {
  const needsTenant = roles.some((item) =>
    item.grants.some((grant) => grant.scope === 'tenant'),
  );
  const needsTeam = roles.some((item) =>
    item.grants.some((grant) => grant.scope === 'team'),
  );
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

export function definePolicy<TUser, TPrincipal extends Principal>(
  permissions: PermissionTree,
  options: {
    readonly roles: readonly Role[];
    readonly scopes?: PolicyScopes;
    readonly subject: (user: TUser) => TPrincipal | null;
    readonly context?: (
      user: TUser,
    ) =>
      | Readonly<Record<string, unknown>>
      | Promise<Readonly<Record<string, unknown>>>;
    readonly validate?: ValidateMode;
    readonly onDenied?: (decision: unknown) => never | void;
    readonly providers?: readonly DecisionProvider[];
  },
): Policy<TUser, TPrincipal> {
  const resources = getRegistry(permissions);
  assertParentGraph(resources);
  const merged = new Map<string, Role>();
  for (const item of options.roles) {
    const existing = merged.get(item.name);
    if (existing === undefined) {
      merged.set(item.name, item);
      continue;
    }
    merged.set(
      item.name,
      freezeDeep(
        compact<Role>({
          name: item.name,
          grants: [...existing.grants, ...item.grants],
          on: existing.on,
          assignable: existing.assignable,
        }),
      ),
    );
  }
  const roles = [...merged.values()];
  const scopes = options.scopes ?? {};
  assertScopedResources(roles, scopes, resources);
  const fingerprint = bytesToBase64Url(sha256(canonicalGrants(roles)));
  return freezeDeep({
    permissions,
    roles,
    rolesByName: merged,
    scopes,
    subject: options.subject,
    context: options.context,
    validate: options.validate ?? 'boundary',
    onDenied: options.onDenied,
    fingerprint,
    resources,
    providers: options.providers,
  }) as Policy<TUser, TPrincipal>;
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
