import type { Condition, Grant, Policy } from 'permdock';

import { hasConditionOp } from 'permdock';

import type { RlsSqlContext } from './rls-sql.ts';

import {
  andConditions,
  compileConditionSql,
  quoteLiteral,
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

function parentFields(policy: Policy, resourceName: string): readonly string[] {
  const fields: string[] = [];
  let current = policy.resources.get(resourceName);
  const seen = new Set<string>();
  while (current?.parent !== undefined) {
    if (seen.has(current.name)) {
      break;
    }
    seen.add(current.name);
    fields.push(current.parent.field);
    current = policy.resources.get(current.parent.resource);
  }
  return fields;
}

function scopeCondition(grant: Grant, policy: Policy): Condition | undefined {
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
  const resourceName = grant.scope.resource;
  const node = policy.resources.get(resourceName);
  return {
    op: 'memberOf',
    scope: 'resource',
    field: node?.id ?? 'id',
    roles: grant.role === null ? [] : [grant.role],
    resource: resourceName,
    parents: parentFields(policy, resourceName),
  };
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
  rbac: boolean,
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
  const scoped = andConditions(scopeCondition(grant, policy), grant.where);
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
  if (rbac) {
    const call = `(select authorize(${quoteLiteral(grant.permission.key)}))`;
    using =
      using === undefined || using === 'true' ? call : `${call} and (${using})`;
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
