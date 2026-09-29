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
  authenticated,
  flattenGrantee,
  roleNameOf,
  roleScopeOf,
} from './grantee.ts';
import { assertLimit, normalizeLimit } from './limits.ts';
import { isForbiddenKey } from './paths.ts';
import {
  type Permission,
  type PermissionKind,
  type PermissionTree,
  type ResourceNode,
  getRegistry,
  isRegistryTree,
  listPermissions,
} from './permissions.ts';
import {
  type PolicyScopesInput,
  type Scope,
  type ScopeNames,
  defineScopes,
  resolveScope,
} from './scopes.ts';
import { sha256, bytesToBase64Url } from './sha256.ts';
import { relatesTo } from './tenancy.ts';
import {
  type PlanTree,
  type Role as RoleLeaf,
  type RoleMeta,
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

export type ApprovalRequirement = {
  readonly by: Grantee | readonly Grantee[];
  /** `false` lets the request's principal approve it; absent means `true`. */
  readonly distinct?: boolean;
  /** `'resource-change'` binds the approval to the row's `version` field. */
  readonly staleOn?: 'resource-change';
};

export type ApprovalOption =
  | 'human'
  | {
      readonly by?: GranteeInput;
      /** `false` lets the request's principal approve it; absent means `true`. */
      readonly distinct?: boolean;
      /**
       * `'resource-change'`: the approval covers the row as it was when it was
       * requested. The resource must declare `version`; once that field
       * changes, resuming denies with `stale-approval`.
       */
      readonly staleOn?: 'resource-change';
    };

/**
 * A quota on a grant. `hard` (the default) denies past `count`; `soft` grants
 * with an `over-limit` obligation. `alertAt` (a fraction of `count`, above 0
 * and at most 1) adds a `near-limit` obligation once usage reaches it.
 */
export type GrantLimit = {
  readonly count: number;
  readonly per: string;
  readonly mode?: 'hard' | 'soft';
  readonly alertAt?: number;
};

export type GrantOptions<T = Record<string, unknown>> = {
  readonly to?: GranteeInput;
  readonly where?: WhereShorthand<T> | Condition;
  readonly check?: WhereShorthand<T> | Condition;
  readonly approval?: ApprovalOption;
  readonly limit?: GrantLimit;
  readonly reason?: string;
  readonly fields?: readonly (keyof T & string)[];
};

/** A declared scope name (or the `tenant` / `team` alias), or the resource a role is held on. */
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
  /** Fewest holders a scope instance keeps (checked at commit); default 0. Needs a named-scope `on`. */
  readonly min?: number;
  /** Most holders a scope instance may have. Needs a named-scope `on`. */
  readonly max?: number;
  /** The holder count of a scope instance never changes: the role only moves by transfer. */
  readonly transferOnly?: boolean;
  /**
   * Roles a holder may assign and revoke. Once any role declares `assigns`,
   * a role nobody lists is assigned only by `meta.manageRoles` holders.
   */
  readonly assigns?: readonly string[];
  /** Membership kinds (`via`) that may hold the role; others hold it for nothing. */
  readonly for?: readonly string[];
  readonly meta?: RoleMeta;
  /** Reserved for time-boxed role activation; setting it throws until it ships. */
  readonly activation?: never;
  /** Reserved for restricted credentials; setting it throws until it ships. */
  readonly restricted?: never;
};

/** Where a grant applies: `'global'`, a declared scope name, or one resource. */
export type GrantScope = string | { readonly resource: string };

export type Grant = {
  readonly permission: Permission;
  readonly effect: 'allow' | 'deny';
  readonly to: Grantee | readonly Grantee[];
  readonly role: string | null;
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: 'human' | ApprovalRequirement;
  readonly portable: boolean;
  readonly closure?: ClosureGrantFn;
  readonly limit?: GrantLimit;
  readonly fields?: readonly string[];
  readonly scope: GrantScope;
  /** Set only on a grant merged from a hosted policy document. */
  readonly hosted?: HostedGrantRef;
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
};

export type ValidateMode = 'boundary' | 'always' | 'never';

/** The declared scopes, in declaration order; empty when the policy declares none. */
export type PolicyScopes = readonly Scope[];

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
  /** Permission keys a hosted policy document may grant or deny; empty by default. */
  readonly hostable: readonly string[];
};

export { requiresApproval } from './approval-required.ts';

export function normalizeApproval(
  approval: ApprovalOption | undefined,
): Grant['approval'] {
  if (approval === undefined) {
    return undefined;
  }
  if (approval === 'human') {
    return 'human';
  }
  if (
    approval.staleOn !== undefined &&
    approval.staleOn !== 'resource-change'
  ) {
    throw new Error(
      `PermDock: approval staleOn must be 'resource-change', got '${String(approval.staleOn)}'`,
    );
  }
  const by = approval.by === undefined ? undefined : asGrantee(approval.by);
  if (
    by === undefined &&
    approval.distinct === undefined &&
    approval.staleOn === undefined
  ) {
    return 'human';
  }
  return compact<ApprovalRequirement>({
    by: by ?? authenticated(),
    distinct: approval.distinct,
    staleOn: approval.staleOn,
  });
}

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
  if (typeof on === 'string') {
    if (on === 'global' || on === 'resource') {
      throw new Error(`PermDock: role on: '${on}' is not a scope name`);
    }
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
  assertLimit(condition?.limit, permission.key);
  const portable = condition?.limit === undefined;
  return compact<Omit<Grant, 'role' | 'scope'>>({
    permission,
    effect,
    to,
    where,
    check,
    approval: normalizeApproval(condition?.approval),
    portable,
    limit: normalizeLimit(condition?.limit),
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

type RoleGrants = readonly (
  | Omit<Grant, 'role' | 'scope'>
  | readonly Omit<Grant, 'role' | 'scope'>[]
)[];

/** A role held at a named scope: `on` is checked against `definePolicy({ scopes })`. */
export function role<const S extends string>(
  name: string | RoleLeaf,
  grants: RoleGrants,
  options: RoleOptions<S> & { readonly on: S },
): RoleBinding<S>;
/** A global role, or one held on a resource. */
export function role(
  name: string | RoleLeaf,
  grants: RoleGrants,
  options?: RoleOptions<never>,
): RoleBinding<never>;
/** Options built at runtime: the scope name is only checked by `definePolicy`. */
export function role(
  name: string | RoleLeaf,
  grants: RoleGrants,
  options?: RoleOptions,
): RoleBinding;
export function role(
  name: string | RoleLeaf,
  grants: RoleGrants,
  options?: RoleOptions,
): RoleBinding {
  for (const reserved of ['activation', 'restricted'] as const) {
    if (options !== undefined && Object.hasOwn(options, reserved)) {
      throw new Error(`PermDock: role option '${reserved}' is reserved`);
    }
  }
  const leaf = isRole(name) ? name : undefined;
  const roleName = leaf?.key ?? (name as string);
  const scope = resolveRoleScope(options?.on ?? leaf?.on);
  const assignable =
    options?.assignable ?? leaf?.assignable ?? scope !== 'global';
  const rules = roleRules(roleName, scope, options);
  const roleGrantee = asGrantee(
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
      exclusiveWith: options?.exclusiveWith,
      ...rules,
      meta: options?.meta ?? leaf?.meta,
    }),
  );
}

type RoleRules = Pick<
  RoleBinding,
  'min' | 'max' | 'transferOnly' | 'assigns' | 'for'
>;

function nameList(
  roleName: string,
  option: string,
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (item) => typeof item !== 'string' || item === '' || isForbiddenKey(item),
    )
  ) {
    throw new Error(
      `PermDock: role '${roleName}' ${option} must be a list of names`,
    );
  }
  return [...new Set(value as readonly string[])];
}

function holderCount(
  roleName: string,
  option: string,
  value: unknown,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `PermDock: role '${roleName}' ${option} must be a whole number of holders`,
    );
  }
  return value;
}

/** Ownership rules count holders per scope instance, so they need a named-scope role. */
function roleRules(
  roleName: string,
  scope: Grant['scope'],
  options: RoleOptions | undefined,
): RoleRules {
  const min = holderCount(roleName, 'min', options?.min);
  const max = holderCount(roleName, 'max', options?.max);
  const transferOnly = options?.transferOnly;
  if (transferOnly !== undefined && typeof transferOnly !== 'boolean') {
    throw new Error(
      `PermDock: role '${roleName}' transferOnly must be a boolean`,
    );
  }
  if (max !== undefined && max < 1) {
    throw new Error(`PermDock: role '${roleName}' max must be at least 1`);
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`PermDock: role '${roleName}' min must not exceed max`);
  }
  const counted =
    (min !== undefined && min > 0) ||
    max !== undefined ||
    transferOnly === true;
  if (counted && (typeof scope !== 'string' || scope === 'global')) {
    throw new Error(
      `PermDock: role '${roleName}' min, max and transferOnly need on: '<scope>'`,
    );
  }
  return compact<RoleRules>({
    min,
    max,
    transferOnly,
    assigns: nameList(roleName, 'assigns', options?.assigns),
    for: nameList(roleName, 'for', options?.for),
  });
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

function scopeOfGrant(
  scope: Grant['scope'],
  declared: readonly Scope[],
): Grant['scope'] {
  if (typeof scope !== 'string' || scope === 'global') {
    return scope;
  }
  const resolved = resolveScope(declared, scope);
  if (resolved === undefined) {
    throw new Error(
      `PermDock: definePolicy({ scopes }) must declare '${scope}' for on: '${scope}' roles`,
    );
  }
  return resolved;
}

function rescopeGrantee(
  to: Grant['to'],
  declared: readonly Scope[],
): Grant['to'] {
  const items = flattenGrantee(to);
  if (!items.some((item) => item.kind === 'role')) {
    return to;
  }
  const mapped = items.map((item) =>
    item.kind === 'role'
      ? freezeDeep({ ...item, scope: scopeOfGrant(item.scope, declared) })
      : item,
  );
  return Array.isArray(to) ? freezeDeep(mapped) : mapped[0]!;
}

/** Resolves `tenant` / `team` aliases to declared names; an undeclared scope throws. */
function rescopeGrant(grant: Grant, declared: readonly Scope[]): Grant {
  const scope = scopeOfGrant(grant.scope, declared);
  const to = rescopeGrantee(grant.to, declared);
  if (scope === grant.scope && to === grant.to) {
    return grant;
  }
  return freezeDeep({ ...grant, scope, to });
}

function rescopeBinding(
  binding: RoleBinding,
  declared: readonly Scope[],
): RoleBinding {
  const grants = binding.grants.map((grant) => rescopeGrant(grant, declared));
  const on =
    typeof binding.on === 'string'
      ? scopeOfGrant(binding.on, declared)
      : binding.on;
  return freezeDeep(
    compact<RoleBinding>({ ...binding, grants, on: on as RoleScope }),
  );
}

/**
 * No implicit cascade: a grant on scope S reaches a row only through the row's
 * own S key, so every resource an instance grant on S touches declares a
 * `memberOf: S` relation on that key. Without it `where()` and RLS could not
 * narrow the rows.
 */
function assertScopeKeys(
  grants: readonly Grant[],
  scopes: readonly Scope[],
  resources: ReadonlyMap<string, ResourceNode>,
): void {
  for (const grant of grants) {
    if (
      typeof grant.scope !== 'string' ||
      grant.scope === 'global' ||
      grant.permission.kind !== 'instance'
    ) {
      continue;
    }
    const key = scopes.find((scope) => scope.name === grant.scope)?.key;
    const node = resources.get(grant.permission.resource);
    if (
      key === undefined ||
      node === undefined ||
      relatesTo(node, key, grant.scope, scopes)
    ) {
      continue;
    }
    throw new Error(
      `PermDock: resource '${node.name}' needs relations: { <name>: { field: '${key}', memberOf: '${grant.scope}' } } for ${grant.permission.key} on '${grant.scope}' roles`,
    );
  }
}

/**
 * A stale-on-change approval needs a row to version: an instance permission
 * whose resource declares `version`.
 */
function assertApprovalVersions(
  grants: readonly Grant[],
  resources: ReadonlyMap<string, ResourceNode>,
): void {
  for (const grant of grants) {
    const approval = grant.approval;
    if (
      approval === undefined ||
      approval === 'human' ||
      approval.staleOn === undefined
    ) {
      continue;
    }
    if (grant.permission.kind !== 'instance') {
      throw new Error(
        `PermDock: approval staleOn on '${grant.permission.key}' needs an instance action; a collection action has no row to version`,
      );
    }
    const node = resources.get(grant.permission.resource);
    if (node?.version === undefined) {
      throw new Error(
        `PermDock: approval staleOn on '${grant.permission.key}' needs resource(..., { version: '<field>' }) on '${grant.permission.resource}'`,
      );
    }
  }
}

function isVocabularyInput(value: unknown): value is PolicyVocabulary {
  return (
    value !== null &&
    typeof value === 'object' &&
    'permissions' in value &&
    isRegistryTree((value as PolicyVocabulary).permissions)
  );
}

export function completeGrant(grant: Omit<Grant, 'role' | 'scope'>): Grant {
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
          exclusiveWith: existing.exclusiveWith ?? item.exclusiveWith,
          min: existing.min ?? item.min,
          max: existing.max ?? item.max,
          transferOnly: existing.transferOnly ?? item.transferOnly,
          assigns: existing.assigns ?? item.assigns,
          for: existing.for ?? item.for,
          meta: existing.meta ?? item.meta,
        }),
      ),
    );
  }
  return { roles: [...merged.values()], rolesByName: merged };
}

export type DefinePolicyOptions<
  TUser,
  TPrincipal extends Principal,
  S extends PolicyScopesInput = PolicyScopesInput,
> = {
  readonly roles?: readonly RoleBinding<ScopeNames<S>>[];
  readonly grants?: readonly (
    | Omit<Grant, 'role' | 'scope'>
    | readonly Omit<Grant, 'role' | 'scope'>[]
    | Grant
  )[];
  /**
   * Named scopes in order, each with the row field holding its id and an
   * optional parent (`within`, an earlier scope). `tenant` and `team` alias
   * the first and second scope.
   */
  readonly scopes?: S;
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
  /**
   * Leaves or subtrees a hosted policy document (`PolicySource`) may touch.
   * The default is none, so a policy without it ignores every hosted grant.
   */
  readonly hostable?: readonly (Permission | PermissionTree)[];
};

export function definePolicy<
  TUser,
  TPrincipal extends Principal,
  const Input extends PermissionTree | PolicyVocabulary,
  const S extends PolicyScopesInput = PolicyScopesInput,
>(
  permissions: Input,
  options: DefinePolicyOptions<TUser, TPrincipal, S>,
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
  const scopes = defineScopes(options.scopes);
  const { roles, rolesByName } = mergeBindings(
    (options.roles ?? []).map((binding) => rescopeBinding(binding, scopes)),
  );
  const declared = new Set(roles.map((item) => item.name));
  for (const leaf of listRoles(vocabulary.roles)) {
    declared.add(leaf.key);
  }
  for (const binding of roles) {
    for (const name of binding.assigns ?? []) {
      if (!declared.has(name)) {
        throw new Error(
          `PermDock: role '${binding.name}' names undeclared role '${name}'`,
        );
      }
    }
  }
  const fromBindings = roles.flatMap((item) => item.grants);
  const fromGrants = flattenGrants(
    (options.grants ?? []) as readonly (
      | Omit<Grant, 'role' | 'scope'>
      | readonly Omit<Grant, 'role' | 'scope'>[]
    )[],
  )
    .map(completeGrant)
    .map((grant) => rescopeGrant(grant, scopes));
  const grants = [...fromBindings, ...fromGrants];
  assertScopeKeys(grants, scopes, resources);
  assertApprovalVersions(grants, resources);
  const fingerprint = bytesToBase64Url(sha256(canonicalGrants(grants)));
  const hostable = [
    ...new Set(
      (options.hostable ?? []).flatMap((item) =>
        flattenPermissions(item).map((leaf) => leaf.key),
      ),
    ),
  ].toSorted();
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
    hostable,
  }) as Policy<TUser, TPrincipal, VocabularyFromInput<Input>>;
}

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

export function exclusivePairs(
  policy: Policy,
): ReadonlyMap<string, readonly string[]> {
  const pairs = new Map<string, readonly string[]>();
  for (const binding of policy.roles) {
    if (binding.exclusiveWith !== undefined) {
      pairs.set(binding.name, binding.exclusiveWith);
    }
  }
  return pairs;
}

export function grantList(policy: Policy): readonly Grant[] {
  if (policy.grants !== undefined && policy.grants.length > 0) {
    return policy.grants;
  }
  return policy.roles.flatMap((binding) => binding.grants);
}

export function declaredRoleNames(policy: Policy): ReadonlySet<string> {
  const names = new Set(policy.roles.map((item) => item.name));
  for (const leaf of listRoles(policy.vocabulary.roles)) {
    names.add(leaf.key);
  }
  return names;
}

export function separationConflicts(
  policy: Policy,
  memberships: readonly MembershipFixture[],
): readonly SeparationConflict[] {
  const exclusive = exclusivePairs(policy);
  const seen = new Set<string>();
  const conflicts: SeparationConflict[] = [];
  for (const membership of memberships) {
    const held = new Set(membership.roles);
    for (const name of held) {
      for (const other of exclusive.get(name) ?? []) {
        if (!held.has(other)) {
          continue;
        }
        const pair = [name, other].toSorted() as [string, string];
        const key = `${membership.principal ?? ''}:${membership.tenant ?? ''}:${pair.join('+')}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        conflicts.push(
          compact<SeparationConflict>({
            principal: membership.principal ?? '',
            tenant: membership.tenant,
            roles: pair,
          }),
        );
      }
    }
  }
  return conflicts;
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
