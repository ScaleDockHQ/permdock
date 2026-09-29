import type {
  Condition,
  ConditionValue,
  RelatedCondition,
} from '../conditions/ast.ts';
import type { DenialReason } from './decision.ts';
import type {
  Permission,
  PermissionTree,
  PrincipalRelation,
  ResourceNode,
} from './permissions.ts';
import type { Subject } from './subject.ts';
import type { Plan, Role } from './vocabulary.ts';

import { compact } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import {
  isEdgeRelation,
  isFieldRelation,
  isPrincipalRelation,
  isSelfParented,
  listPermissions,
} from './permissions.ts';
import {
  type Scope,
  activeFor,
  resolveScope,
  rootScope,
  scopeList,
} from './scopes.ts';
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
  /** Follow the row's `parent` chain upward to `resource`, then its own parents. */
  readonly through?: 'parent';
  /** Parent hops walked above the first `resource` instance; absent means `DEFAULT_RELATION_DEPTH`. */
  readonly depth?: number;
};

export const DEFAULT_RELATION_DEPTH = 16;
export const MAX_RELATION_DEPTH = 32;
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
  options?: { readonly through?: 'parent'; readonly depth?: number },
): RelationGrantee {
  const leaves = listPermissions(resource);
  const resourceName = leaves[0]?.resource;
  if (resourceName === undefined) {
    throw new Error('PermDock: relation() requires a resource tree');
  }
  const through = options?.through;
  if (through !== undefined && through !== 'parent') {
    throw new Error(
      `PermDock: relation() through must be 'parent' (got '${String(through)}')`,
    );
  }
  const depth = options?.depth;
  if (depth !== undefined) {
    if (through === undefined) {
      throw new Error("PermDock: relation() depth needs through: 'parent'");
    }
    if (!Number.isInteger(depth) || depth < 0 || depth > MAX_RELATION_DEPTH) {
      throw new Error(
        `PermDock: relation() depth must be an integer from 0 to ${MAX_RELATION_DEPTH}`,
      );
    }
  }
  return freezeDeep(
    compact<RelationGrantee>({
      kind: 'relation' as const,
      resource: resourceName,
      relation: name,
      through,
      depth,
    }),
  );
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
export type RelationConditionOptions = {
  /** The policy's resource graph, for a relation declared on the row's parent resource. */
  readonly resources?: ReadonlyMap<string, ResourceNode> | undefined;
  /** The instant a principal relation's `period` is compared against: a date in process, `{ ref: 'now' }` in SQL. */
  readonly now?: ConditionValue;
};

/**
 * Where a graph relation starts on the row: its own id when the relation is
 * on the row's resource, the parent field when it is on the parent resource.
 * `undefined` when `through` cannot reach the relation's resource.
 */
export function relationStart(
  grantee: RelationGrantee,
  resource: ResourceNode | undefined,
  target: ResourceNode | undefined,
):
  | {
      readonly field: string;
      readonly parent: boolean;
      readonly depth: number;
    }
  | undefined {
  if (resource === undefined || target === undefined) {
    return undefined;
  }
  const walks = grantee.through === 'parent' && isSelfParented(target);
  const depth = walks ? (grantee.depth ?? DEFAULT_RELATION_DEPTH) : 0;
  if (target.name === resource.name) {
    return { field: resource.id, parent: false, depth };
  }
  if (
    grantee.through === 'parent' &&
    resource.parent?.resource === target.name
  ) {
    return { field: resource.parent.field, parent: true, depth };
  }
  return undefined;
}

/** Whether the grantee needs the relation graph: a `through` walk or an edge table. */
export function isGraphRelation(
  grantee: RelationGrantee,
  resources: ReadonlyMap<string, ResourceNode> | undefined,
): boolean {
  if (grantee.through !== undefined) {
    return true;
  }
  return isEdgeRelation(
    resources?.get(grantee.resource)?.relations[grantee.relation],
  );
}

function periodConditions(
  spec: PrincipalRelation,
  now: ConditionValue,
): readonly Condition[] {
  const out: Condition[] = [];
  const startsAt = spec.period?.startsAt;
  if (startsAt !== undefined) {
    out.push({
      op: 'or',
      conditions: [
        { op: 'isNull', field: startsAt, value: true },
        { op: 'lte', field: startsAt, value: now },
      ],
    });
  }
  const expiresAt = spec.period?.expiresAt;
  if (expiresAt !== undefined) {
    out.push({
      op: 'or',
      conditions: [
        { op: 'isNull', field: expiresAt, value: true },
        { op: 'gt', field: expiresAt, value: now },
      ],
    });
  }
  return out;
}

export function relationCondition(
  grantee: RelationGrantee,
  resource: ResourceNode | undefined,
  scopes: readonly Scope[] = scopeList(undefined),
  options: RelationConditionOptions = {},
): Condition | undefined {
  const target =
    grantee.resource === resource?.name
      ? resource
      : options.resources?.get(grantee.resource);
  if (isGraphRelation(grantee, options.resources ?? targetMap(target))) {
    const spec = target?.relations[grantee.relation];
    if (
      spec === undefined ||
      (isFieldRelation(spec) && spec.memberOf !== undefined)
    ) {
      return undefined;
    }
    const start = relationStart(grantee, resource, target);
    if (start === undefined || target === undefined) {
      return undefined;
    }
    return compact<RelatedCondition>({
      op: 'related',
      resource: target.name,
      relation: grantee.relation,
      field: start.field,
      depth: start.depth,
      parent: start.parent ? true : undefined,
      restricted:
        start.parent || start.depth > 0 ? resource?.restricted : undefined,
    });
  }
  const spec = resource?.relations?.[grantee.relation];
  if (spec === undefined || isEdgeRelation(spec)) {
    return undefined;
  }
  if (isPrincipalRelation(spec)) {
    const owner: Condition = {
      op: 'eq',
      field: spec.principal,
      value: { ref: 'principal.id' },
    };
    const period = periodConditions(
      spec,
      options.now ?? { date: new Date().toISOString() },
    );
    return period.length === 0
      ? owner
      : { op: 'and', conditions: [owner, ...period] };
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

function targetMap(
  target: ResourceNode | undefined,
): ReadonlyMap<string, ResourceNode> | undefined {
  return target === undefined ? undefined : new Map([[target.name, target]]);
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
  resources: ReadonlyMap<string, ResourceNode> | undefined,
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
      const where = relationCondition(grantee, resource, scopes, {
        resources,
        now: { date: new Date(now * 1000).toISOString() },
      });
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
  resources?: ReadonlyMap<string, ResourceNode>,
): GranteeMatch {
  const items = flattenGrantee(to);
  if (items.length === 0) {
    return { matched: false, reason: 'no-grant' };
  }
  let where: Condition | undefined;
  for (const item of items) {
    const result = matchOne(item, subject, now, resource, scopes, resources);
    if (!result.matched) {
      return result;
    }
    where = combineWhere(where, result.where);
  }
  return compact<GranteeMatch>({ matched: true, where });
}
