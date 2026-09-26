import type { Condition, Grant, Policy, ResourceNode } from 'permdock';

import { hasConditionOp } from 'permdock';

import type { RlsSqlContext } from './rls-sql.ts';

import { authorizeCall } from './rls-rbac.ts';
import {
  andConditions,
  compileConditionSql,
  sqlFunctionNames,
} from './rls-sql.ts';

export type SqlCommand = 'select' | 'insert' | 'update' | 'delete';

export type CompiledPolicy = {
  readonly name: string;
  readonly table: string;
  readonly command: SqlCommand;
  readonly effect: 'allow' | 'deny';
  readonly roles: readonly string[];
  readonly using?: string;
  readonly check?: string;
  readonly permissionKey: string;
};

function grantRoleName(grant: Grant): string {
  return grant.role ?? 'grant';
}

function commandFor(action: string): SqlCommand | undefined {
  switch (action) {
    case 'read':
    case 'list':
    case 'get':
      return 'select';
    case 'create':
      return 'insert';
    case 'update':
      return 'update';
    case 'delete':
      return 'delete';
    default:
      return undefined;
  }
}

export function tableFor(
  resource: string,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  return tables?.[resource] ?? resource;
}

function scopeCondition(
  grant: Grant,
  policy: Policy,
  ctx: RlsSqlContext,
): Condition | undefined {
  if (grant.scope === 'global') {
    return undefined;
  }
  if (grant.scope === 'tenant') {
    const field = policy.scopes.tenant?.key;
    if (field === undefined) {
      throw new Error(
        'PermDock CLI: tenant-scoped grant needs definePolicy({ scopes.tenant })',
      );
    }
    return {
      op: 'memberOf',
      scope: 'tenant',
      field,
      roles: grant.role === null ? [] : [grant.role],
    };
  }
  if (grant.scope === 'team') {
    const field = policy.scopes.team?.key;
    if (field === undefined) {
      throw new Error(
        'PermDock CLI: team-scoped grant needs definePolicy({ scopes.team })',
      );
    }
    return {
      op: 'memberOf',
      scope: 'team',
      field,
      roles: grant.role === null ? [] : [grant.role],
    };
  }
  // Mirrors `matchResourceMembership`: a membership on the role's resource or
  // one of its ancestors, keyed by the row field that holds that resource's id.
  const roleResource = grant.scope.resource;
  const target = policy.resources.get(grant.permission.resource);
  const holders = [roleResource, ...ancestorsOf(policy, roleResource)];
  const hops: Condition[] = [];
  for (const [index, holder] of holders.entries()) {
    const field = membershipField(policy, target, holder);
    if (field === undefined) {
      continue;
    }
    if (index > 0 && ctx.memberships?.resource?.[holder] === undefined) {
      continue;
    }
    hops.push({
      op: 'memberOf',
      scope: 'resource',
      field,
      roles: grant.role === null ? [] : [grant.role],
      resource: holder,
    });
  }
  return hops.length === 1 ? hops[0] : { op: 'or', conditions: hops };
}

function ancestorsOf(policy: Policy, name: string): readonly string[] {
  const names: string[] = [];
  let current = policy.resources.get(name);
  while (
    current?.parent !== undefined &&
    !names.includes(current.parent.resource)
  ) {
    names.push(current.parent.resource);
    current = policy.resources.get(current.parent.resource);
  }
  return names;
}

function membershipField(
  policy: Policy,
  resource: ResourceNode | undefined,
  holder: string,
): string | undefined {
  if (resource === undefined) {
    return undefined;
  }
  if (resource.name === holder) {
    return resource.id ?? 'id';
  }
  let current: ResourceNode | undefined = resource;
  const seen = new Set<string>();
  while (current?.parent !== undefined && !seen.has(current.name)) {
    seen.add(current.name);
    if (current.parent.resource === holder) {
      return current.parent.field;
    }
    current = policy.resources.get(current.parent.resource);
  }
  return undefined;
}

function policyRoles(roleName: string): readonly string[] {
  if (roleName === 'anonymous' || roleName === 'anon') {
    return ['anon', 'authenticated'];
  }
  return ['authenticated'];
}

function policyName(
  role: string,
  resource: string,
  action: string,
  effect: 'allow' | 'deny',
): string {
  const prefix = effect === 'deny' ? 'deny_' : '';
  return `${prefix}${role}_${resource}_${action}`.replaceAll(
    /[^A-Za-z0-9_]/g,
    '_',
  );
}

export function compileGrant(
  grant: Grant,
  policy: Policy,
  ctx: RlsSqlContext,
  tables: Readonly<Record<string, string>> | undefined,
  rbac: { readonly schema: string } | undefined,
  warnings: string[],
  skipClosures: boolean,
): CompiledPolicy | undefined {
  if (grant.closure !== undefined || grant.portable === false) {
    if (skipClosures) {
      warnings.push(
        `skipped non-portable grant ${grantRoleName(grant)}/${grant.permission.key}`,
      );
      return undefined;
    }
    throw new Error(
      `PermDock CLI: closure grant ${grantRoleName(grant)}/${grant.permission.key} is not portable; rewrite it or pass --skip-closures`,
    );
  }
  if (grant.approval === 'human') {
    warnings.push(
      `skipped approval:human grant ${grantRoleName(grant)}/${grant.permission.key}`,
    );
    return undefined;
  }
  const command = commandFor(grant.permission.action);
  if (command === undefined) {
    warnings.push(
      `skipped ${grant.permission.key}: action is not a SQL command`,
    );
    return undefined;
  }
  const scoped = andConditions(scopeCondition(grant, policy, ctx), grant.where);
  const check = grant.check ?? (command === 'update' ? grant.where : undefined);
  let using =
    command === 'insert'
      ? undefined
      : scoped === undefined
        ? 'true'
        : compileConditionSql(scoped, ctx);
  let withCheck =
    command === 'insert' || command === 'update'
      ? check === undefined && scoped === undefined
        ? 'true'
        : compileConditionSql(
            check ?? scoped ?? { op: 'eq', field: '_', value: true },
            ctx,
          )
      : undefined;
  if (command === 'insert' && scoped !== undefined && check === undefined) {
    withCheck = compileConditionSql(scoped, ctx);
  }
  const functionNames = [
    ...sqlFunctionNames(scoped),
    ...sqlFunctionNames(check),
  ];
  if (functionNames.length > 0) {
    warnings.push(
      `sqlFunction ${[...new Set(functionNames)].join(', ')} on ${grantRoleName(grant)}/${grant.permission.key} is portable via twin`,
    );
  }
  if (hasConditionOp(scoped, 'opaque') || hasConditionOp(check, 'opaque')) {
    warnings.push(
      `opaque SQL on ${grantRoleName(grant)}/${grant.permission.key} is untestable app-side`,
    );
  }
  if (rbac !== undefined) {
    const call = authorizeCall(
      rbac.schema,
      grant.permission.key,
      grant.scope === 'tenant' ? policy.scopes.tenant?.key : undefined,
    );
    if (command !== 'insert') {
      using =
        using === undefined || using === 'true'
          ? call
          : `${call} and (${using})`;
    }
    if (withCheck !== undefined) {
      withCheck = withCheck === 'true' ? call : `${call} and (${withCheck})`;
    }
  }
  if (grant.effect === 'deny') {
    if (using !== undefined) {
      using = `not (${using})`;
    }
    if (withCheck !== undefined) {
      withCheck = `not (${withCheck})`;
    }
  }
  return {
    name: policyName(
      grantRoleName(grant),
      grant.permission.resource,
      grant.permission.action,
      grant.effect,
    ),
    table: tableFor(grant.permission.resource, tables),
    command,
    effect: grant.effect,
    roles: policyRoles(grantRoleName(grant)),
    ...(using === undefined ? {} : { using }),
    ...(withCheck === undefined ? {} : { check: withCheck }),
    permissionKey: grant.permission.key,
  };
}

export function ensureSelectCoverage(
  policies: CompiledPolicy[],
  warnings: string[],
): CompiledPolicy[] {
  const extra: CompiledPolicy[] = [];
  const seen = new Set(
    policies
      .filter((item) => item.command === 'select')
      .map((item) => `${item.table}:${item.roles.join(',')}`),
  );
  for (const item of policies) {
    if (item.command !== 'update' && item.command !== 'delete') {
      continue;
    }
    const key = `${item.table}:${item.roles.join(',')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    extra.push({
      name: `${item.name}_select_coverage`,
      table: item.table,
      command: 'select',
      effect: 'allow',
      roles: item.roles,
      using: item.using ?? 'true',
      permissionKey: item.permissionKey,
    });
    warnings.push(
      `added SELECT coverage for ${item.table} (${item.permissionKey})`,
    );
  }
  return [...policies, ...extra];
}
