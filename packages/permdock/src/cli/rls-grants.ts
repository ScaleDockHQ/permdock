import type { Condition, Grant, Grantee, Policy } from '../index.ts';

import { relationCondition } from '../core/grantee.ts';
import { scopeList } from '../core/scopes.ts';
import { listRoles } from '../index.ts';
import { andConditions } from './rls-sql.ts';

/** Who a grant reaches before any row condition applies. */
export type RlsAccess =
  | { readonly kind: 'anyone' }
  | { readonly kind: 'authenticated' }
  | {
      readonly kind: 'role';
      readonly role: string;
      /** `'global'` or a scope name. */
      readonly scope: string;
    }
  | {
      readonly kind: 'resource';
      readonly role: string;
      readonly resource: string;
    };

export type RlsGrant = {
  readonly grant: Grant;
  /** Role name, or `anyone` / `authenticated`, for policy names and messages. */
  readonly label: string;
  readonly access: RlsAccess;
  /** `grant.where` and any relation grantee's row condition, ANDed. */
  readonly where?: Condition;
};

function granteeItems(to: Grant['to']): readonly Grantee[] {
  return Array.isArray(to) ? (to as readonly Grantee[]) : [to as Grantee];
}

function relationWhere(
  policy: Policy,
  grant: Grant,
  grantee: Extract<Grantee, { readonly kind: 'relation' }>,
): Condition {
  const node = policy.resources.get(grant.permission.resource);
  const where = relationCondition(grantee, node, scopeList(policy.scopes));
  if (where === undefined) {
    throw new Error(
      `PermDock CLI: grant ${grant.permission.key} names relation '${grantee.relation}', which ${grant.permission.resource} does not declare`,
    );
  }
  return where;
}

function accessOf(
  grant: Grant,
  roles: readonly Extract<Grantee, { readonly kind: 'role' }>[],
  anyone: boolean,
): RlsAccess {
  const [held, ...more] = roles;
  if (more.length > 0) {
    throw new Error(
      `PermDock CLI: grant ${grant.permission.key} requires several roles at once (${roles.map((item) => item.role).join(', ')}); RLS compiles one role per grant`,
    );
  }
  if (held === undefined) {
    return anyone ? { kind: 'anyone' } : { kind: 'authenticated' };
  }
  if (typeof held.scope === 'object') {
    return {
      kind: 'resource',
      role: held.role,
      resource: held.scope.resource,
    };
  }
  return { kind: 'role', role: held.role, scope: held.scope };
}

/**
 * Every grant RLS must enforce: role grants and top-level
 * `definePolicy({ grants })` alike (`policy.grants` holds both). A grantee
 * Postgres cannot see (plan, actor, assurance) fails with the permission named.
 */
export function collectGrants(policy: Policy): readonly RlsGrant[] {
  return policy.grants.map((grant) => {
    const items = granteeItems(grant.to);
    const roles: Extract<Grantee, { readonly kind: 'role' }>[] = [];
    let anyone = true;
    let where = grant.where;
    for (const item of items) {
      switch (item.kind) {
        case 'role':
          roles.push(item);
          break;
        case 'anyone':
          break;
        case 'authenticated':
          anyone = false;
          break;
        case 'relation':
          anyone = false;
          where = andConditions(where, relationWhere(policy, grant, item));
          break;
        case 'plan':
        case 'actor':
        case 'assurance':
          throw new Error(
            `PermDock CLI: grant ${grant.permission.key} is limited to a ${item.kind} grantee, which RLS cannot compile; enforce it in the application`,
          );
        default: {
          const exhaustive: never = item;
          return exhaustive;
        }
      }
    }
    const access = accessOf(grant, roles, anyone);
    const label =
      access.kind === 'role' || access.kind === 'resource'
        ? access.role
        : access.kind;
    return where === undefined
      ? { grant, label, access }
      : { grant, label, access, where };
  });
}

/** Declared role names (bindings and `defineRoles` leaves) plus any role a top-level grant names. */
export function roleNames(policy: Policy): readonly string[] {
  const names = new Set(policy.roles.map((item) => item.name));
  for (const leaf of listRoles(policy.vocabulary.roles)) {
    names.add(leaf.key);
  }
  for (const item of collectGrants(policy)) {
    if (item.access.kind === 'role' || item.access.kind === 'resource') {
      names.add(item.access.role);
    }
  }
  return [...names];
}
