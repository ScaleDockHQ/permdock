import type { Condition } from '../conditions/ast.ts';
import type { DenialReason } from './decision.ts';
import type {
  Permission,
  PermissionTree,
  ResourceNode,
} from './permissions.ts';
import type { Subject } from './subject.ts';
import type { Plan, Role } from './vocabulary.ts';

import { compact } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import { listPermissions } from './permissions.ts';
import { type Scope, resolveScope, rootScope, scopeList } from './scopes.ts';
import { activeFor } from './tenancy.ts';
import { isPlan, isRole } from './vocabulary.ts';

export type RoleGrantee = {
  readonly kind: 'role';
  readonly role: string;
  /** `'global'`, a scope name, or one resource. */
  readonly scope: string | { readonly resource: string };
};

export type AnyoneGrantee = { readonly kind: 'anyone' };
export type AuthenticatedGrantee = { readonly kind: 'authenticated' };
export type RelationGrantee = {
  readonly kind: 'relation';
  readonly resource: string;
  readonly relation: string;
};
export type PlanGrantee = { readonly kind: 'plan'; readonly plan: string };
export type ActorGrantee = { readonly kind: 'actor'; readonly actor: string };
export type AssuranceGrantee = {
  readonly kind: 'assurance';
  readonly acr?: readonly string[];
  readonly amr?: readonly string[];
  readonly maxAge?: number;
};

export type Grantee =
  | RoleGrantee
  | AnyoneGrantee
  | AuthenticatedGrantee
  | RelationGrantee
  | PlanGrantee
  | ActorGrantee
  | AssuranceGrantee;

export type GranteeInput =
  | Grantee
  | Role
  | Plan
  | string
  | readonly GranteeInput[];

export type GranteeMatch = {
  readonly matched: boolean;
  readonly where?: Condition;
  readonly reason?: DenialReason;
};

function isGrantee(value: unknown): value is Grantee {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    typeof (value as Grantee).kind === 'string'
  );
}

export function anyone(): AnyoneGrantee {
  return freezeDeep({ kind: 'anyone' as const });
}

export function authenticated(): AuthenticatedGrantee {
  return freezeDeep({ kind: 'authenticated' as const });
}

export function relation(
  resource: Permission | PermissionTree,
  name: string,
): RelationGrantee {
  const leaves = listPermissions(resource);
  const resourceName = leaves[0]?.resource;
  if (resourceName === undefined) {
    throw new Error('PermDock: relation() requires a resource tree');
  }
  return freezeDeep({
    kind: 'relation' as const,
    resource: resourceName,
    relation: name,
  });
}

export function plan(name: Plan | string): PlanGrantee {
  return freezeDeep({
    kind: 'plan' as const,
    plan: typeof name === 'string' ? name : name.key,
  });
}

export function actor(kind: string): ActorGrantee {
  return freezeDeep({ kind: 'actor' as const, actor: kind });
}

export function assurance(options: {
  readonly acr?: string | readonly string[];
  readonly amr?: string | readonly string[];
  readonly maxAge?: number;
}): AssuranceGrantee {
  const acr =
    options.acr === undefined
      ? undefined
      : typeof options.acr === 'string'
        ? [options.acr]
        : options.acr;
  const amr =
    options.amr === undefined
      ? undefined
      : typeof options.amr === 'string'
        ? [options.amr]
        : options.amr;
  return freezeDeep(
    compact<AssuranceGrantee>({
      kind: 'assurance' as const,
      acr,
      amr,
      maxAge: options.maxAge,
    }),
  );
}

function resolveRoleScope(on: Role['on'] | undefined): RoleGrantee['scope'] {
  return typeof on === 'string' ? on : 'global';
}

export function asGrantee(input: GranteeInput): Grantee | readonly Grantee[] {
  if (Array.isArray(input)) {
    const items: Grantee[] = [];
    for (const item of input as readonly GranteeInput[]) {
      items.push(...flattenGrantee(asGrantee(item)));
    }
    return items;
  }
  if (typeof input === 'string') {
    return freezeDeep({
      kind: 'role' as const,
      role: input,
      scope: 'global' as const,
    });
  }
  if (isRole(input)) {
    return freezeDeep({
      kind: 'role' as const,
      role: input.key,
      scope: resolveRoleScope(input.on),
    });
  }
  if (isPlan(input)) {
    return freezeDeep({ kind: 'plan' as const, plan: input.key });
  }
  if (isGrantee(input)) {
    return input;
  }
  throw new Error('PermDock: invalid grantee');
}

export function flattenGrantee(
  input: Grantee | readonly Grantee[] | undefined,
): readonly Grantee[] {
  if (input === undefined) {
    return [];
  }
  if (Array.isArray(input)) {
    return input as readonly Grantee[];
  }
  return [input as Grantee];
}

export function roleNameOf(
  to: Grantee | readonly Grantee[] | undefined,
): string | null {
  for (const item of flattenGrantee(to)) {
    if (item.kind === 'role') {
      return item.role;
    }
  }
  return null;
}

export function roleScopeOf(
  to: Grantee | readonly Grantee[] | undefined,
  fallback: RoleGrantee['scope'] = 'global',
): RoleGrantee['scope'] {
  for (const item of flattenGrantee(to)) {
    if (item.kind === 'role') {
      return item.scope;
    }
  }
  return fallback;
}

export function hasAnyone(
  to: Grantee | readonly Grantee[] | undefined,
): boolean {
  return flattenGrantee(to).some((item) => item.kind === 'anyone');
}

/**
 * A `memberOf` relation on the first scope means "the row is in the active
 * tenant"; on any other scope, "the subject holds a membership in the row's
 * instance of it". Shared with the RLS compiler.
 */
export function relationCondition(
  grantee: RelationGrantee,
  resource: ResourceNode | undefined,
  scopes: readonly Scope[] = scopeList(undefined),
): Condition | undefined {
  const spec = resource?.relations?.[grantee.relation];
  if (spec === undefined) {
    return undefined;
  }
  if (spec.memberOf !== undefined) {
    const scope = resolveScope(scopes, spec.memberOf);
    if (scope === undefined) {
      return { op: 'or', conditions: [] };
    }
    if (scope === rootScope(scopes)) {
      return {
        op: 'eq',
        field: spec.field,
        value: { ref: 'principal.tenant' },
      };
    }
    return { op: 'memberOf', scope, field: spec.field, roles: [] };
  }
  return {
    op: 'eq',
    field: spec.field,
    value: { ref: 'principal.id' },
  };
}

export function combineWhere(
  left: Condition | undefined,
  right: Condition | undefined,
): Condition | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return { op: 'and', conditions: [left, right] };
}

/** Seats (`Membership.entitlements`) held through memberships that apply under the active tenant. */
function seatsInTenant(
  subject: Subject,
  scopes: readonly Scope[] | undefined,
): readonly string[] {
  const principal = subject.principal;
  if (principal === null) {
    return [];
  }
  const list = scopeList(scopes);
  return (principal.memberships ?? []).flatMap((membership) =>
    membership.entitlements !== undefined &&
    activeFor(membership, list, principal.tenant)
      ? membership.entitlements
      : [],
  );
}

function matchOne(
  grantee: Grantee,
  subject: Subject,
  now: number,
  resource: ResourceNode | undefined,
  scopes: readonly Scope[] | undefined,
): GranteeMatch {
  switch (grantee.kind) {
    case 'anyone':
      return { matched: true };
    case 'authenticated':
      return subject.principal === null
        ? { matched: false, reason: 'anonymous' }
        : { matched: true };
    case 'plan': {
      if (subject.principal === null) {
        return { matched: false, reason: 'anonymous' };
      }
      const plans = subject.principal.plans ?? [];
      return plans.includes(grantee.plan) ||
        seatsInTenant(subject, scopes).includes(grantee.plan)
        ? { matched: true }
        : { matched: false, reason: 'no-grant' };
    }
    case 'actor': {
      if (subject.actor === undefined) {
        return { matched: false, reason: 'no-grant' };
      }
      return subject.actor.kind === grantee.actor
        ? { matched: true }
        : { matched: false, reason: 'no-grant' };
    }
    case 'assurance': {
      if (subject.principal === null) {
        return { matched: false, reason: 'anonymous' };
      }
      const principalAssurance = subject.principal.assurance;
      if (grantee.acr !== undefined && grantee.acr.length > 0) {
        const acr = principalAssurance?.acr;
        if (acr === undefined || !grantee.acr.includes(acr)) {
          return {
            matched: false,
            reason: 'insufficient-user-authentication',
          };
        }
      }
      if (grantee.amr !== undefined && grantee.amr.length > 0) {
        const amr = principalAssurance?.amr ?? [];
        if (!grantee.amr.every((method) => amr.includes(method))) {
          return {
            matched: false,
            reason: 'insufficient-user-authentication',
          };
        }
      }
      if (grantee.maxAge !== undefined) {
        const authTime = principalAssurance?.authTime;
        if (authTime === undefined || now - authTime > grantee.maxAge) {
          return {
            matched: false,
            reason: 'insufficient-user-authentication',
          };
        }
      }
      return { matched: true };
    }
    case 'relation': {
      if (subject.principal === null) {
        return { matched: false, reason: 'anonymous' };
      }
      const where = relationCondition(grantee, resource, scopes);
      if (where === undefined && resource !== undefined) {
        return { matched: false, reason: 'condition' };
      }
      return compact<GranteeMatch>({ matched: true, where });
    }
    case 'role': {
      if (subject.principal === null) {
        return { matched: false, reason: 'anonymous' };
      }
      return { matched: true };
    }
    default: {
      const exhaustive: never = grantee;
      return exhaustive;
    }
  }
}

export function matchGrantee(
  to: Grantee | readonly Grantee[] | undefined,
  subject: Subject,
  now: number,
  resource: ResourceNode | undefined,
  scopes?: readonly Scope[],
): GranteeMatch {
  const items = flattenGrantee(to);
  if (items.length === 0) {
    return { matched: false, reason: 'no-grant' };
  }
  let where: Condition | undefined;
  for (const item of items) {
    const result = matchOne(item, subject, now, resource, scopes);
    if (!result.matched) {
      return result;
    }
    where = combineWhere(where, result.where);
  }
  return compact<GranteeMatch>({ matched: true, where });
}
