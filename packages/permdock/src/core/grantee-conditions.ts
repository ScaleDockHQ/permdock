import type {
  Condition,
  ConditionValue,
  RelatedCondition,
  RelatedHop,
  RestrictedAncestors,
} from "../conditions/ast.ts";
import type { InheritGrantee, RelationGrantee } from "./grantee.ts";
import type {
  PrincipalRelation,
  ResourceLink,
  ResourceNode,
} from "./permission-types.ts";
import type { Scope } from "./scopes.ts";

import { compact, sole } from "./compact.ts";
import { DEFAULT_RELATION_DEPTH, MAX_RELATION_DEPTH } from "./grantee.ts";
import {
  expandRelation,
  isComputedRelation,
  isEdgeRelation,
  isFieldRelation,
  isPrincipalRelation,
  isSelfParented,
  restrictedFor,
  restrictedStops,
} from "./resource-relations.ts";
import { resolveScope, rootScope, scopeList } from "./scopes.ts";
import { isoNow } from "./time.ts";

/**
 * A `memberOf` relation on the first scope means "the row is in the active
 * tenant"; on any other scope, "the subject holds a membership in the row's
 * instance of it". Shared with the RLS compiler.
 */
export type RelationConditionOptions = {
  /**
   * The policy's resource graph, for a relation declared on the row's parent
   * resource.
   */
  readonly resources?: ReadonlyMap<string, ResourceNode> | undefined;
  /**
   * The instant a principal relation's `period` is compared against: a date in
   * process, `{ ref: 'now' }` in SQL.
   */
  readonly now?: ConditionValue;
  /** `false` while expanding an `includes`: compile the named relation alone. */
  readonly includes?: boolean;
};

/**
 * Where a graph relation starts on the row: its own id when the relation is on
 * the row's resource, the parent field when it is on the parent resource.
 * `undefined` when `through` cannot reach the relation's resource.
 */
export function relationStart(
  grantee: RelationGrantee,
  resource: ResourceNode | undefined,
  target: ResourceNode | undefined,
):
  | { readonly field: string; readonly parent: boolean; readonly depth: number }
  | undefined {
  if (
    resource === undefined ||
    target === undefined ||
    Array.isArray(grantee.through)
  ) {
    return undefined;
  }
  const walks = grantee.through === "parent" && isSelfParented(target);
  const requested = grantee.depth ?? DEFAULT_RELATION_DEPTH;
  const depth = walks
    ? Number.isInteger(requested)
      ? Math.min(Math.max(requested, 0), MAX_RELATION_DEPTH)
      : 0
    : 0;
  if (target.name === resource.name) {
    return { field: resource.id, parent: false, depth };
  }
  if (
    grantee.through === "parent" &&
    resource.parent?.resource === target.name
  ) {
    return { field: resource.parent.field, parent: true, depth };
  }
  return undefined;
}

/**
 * A resource role held on self-parented `membershipResource` instances (`ids`)
 * reaches rows below them: the row itself when it is of that resource, its
 * parent field when its parent is, walked up to the default depth. `undefined`
 * when the row is not on such a chain.
 */
export function resourceRoleCondition(
  resource: ResourceNode | undefined,
  membershipResource: string,
  ids: readonly string[],
  resources: ReadonlyMap<string, ResourceNode>,
): RelatedCondition | undefined {
  if (
    resource === undefined ||
    !isSelfParented(resources.get(membershipResource))
  ) {
    return undefined;
  }
  const start =
    resource.name === membershipResource
      ? { field: resource.id, parent: false }
      : resource.parent?.resource === membershipResource
        ? { field: resource.parent.field, parent: true }
        : undefined;
  if (start === undefined) {
    return undefined;
  }
  return compact<RelatedCondition>({
    op: "related",
    resource: membershipResource,
    relation: "",
    ids: [...new Set(ids)].toSorted(),
    field: start.field,
    depth: DEFAULT_RELATION_DEPTH,
    parent: start.parent ? true : undefined,
    restricted: restrictedFor(resource, "parent"),
    passRestricted: passesRestricted(resources.get(membershipResource)),
  });
}

function passesRestricted(node: ResourceNode | undefined): true | undefined {
  return node?.restricted !== undefined && !restrictedStops(node, "parent")
    ? true
    : undefined;
}

function linkStop(
  resource: ResourceNode,
  link: string,
): {
  readonly restricted?: string;
  readonly restrictedAncestors?: RestrictedAncestors;
} {
  const restricted = restrictedFor(resource, link);
  if (restricted === undefined) {
    return {};
  }
  const parent = resource.parent;
  if (parent === undefined || !isSelfParented(resource)) {
    return { restricted };
  }
  return {
    restricted,
    restrictedAncestors: {
      resource: resource.name,
      id: resource.id,
      parent: parent.field,
      field: restricted,
      depth: MAX_RELATION_DEPTH,
    },
  };
}

/**
 * The link path from the row to the grantee's resource: the row field of the
 * first link and each hop. `undefined` when a link is not declared or the path
 * ends on another resource.
 */
export function relationHops(
  grantee: RelationGrantee,
  resource: ResourceNode | undefined,
  resources: ReadonlyMap<string, ResourceNode> | undefined,
):
  | {
      readonly field: string;
      readonly hops: readonly RelatedHop[];
      readonly depth: number;
    }
  | undefined {
  const through = grantee.through;
  if (!Array.isArray(through) || resource === undefined) {
    return undefined;
  }
  const hops: RelatedHop[] = [];
  let current: ResourceNode | undefined = resource;
  let field: string | undefined;
  // SAFETY: Array.isArray does not narrow a readonly array; relation() only stores string links.
  for (const link of through as readonly string[]) {
    const spec: ResourceLink | undefined =
      current !== undefined && Object.hasOwn(current.links, link)
        ? current.links[link]
        : undefined;
    if (spec === undefined) {
      return undefined;
    }
    field ??= spec.field;
    hops.push({ link, resource: spec.resource });
    current = resources?.get(spec.resource);
  }
  if (
    field === undefined ||
    current === undefined ||
    current.name !== grantee.resource
  ) {
    return undefined;
  }
  const depth = grantee.depth ?? 0;
  if (depth > 0 && !isSelfParented(current)) {
    return undefined;
  }
  return { field, hops, depth };
}

/**
 * Whether the grantee needs the relation graph: a `through` walk, an edge
 * table, or an `includes` that reaches one.
 */
export function isGraphRelation(
  grantee: RelationGrantee,
  resources: ReadonlyMap<string, ResourceNode> | undefined,
): boolean {
  if (grantee.through !== undefined) {
    return true;
  }
  const node = resources?.get(grantee.resource);
  const names = expandRelation(node, grantee.relation);
  return names.some((name) => isEdgeRelation(node?.relations[name]));
}

function periodConditions(
  spec: PrincipalRelation,
  now: ConditionValue,
): readonly Condition[] {
  const out: Condition[] = [];
  const startsAt = spec.period?.startsAt;
  if (startsAt !== undefined) {
    out.push({
      op: "or",
      conditions: [
        { op: "isNull", field: startsAt, value: true },
        { op: "lte", field: startsAt, value: now },
      ],
    });
  }
  const expiresAt = spec.period?.expiresAt;
  if (expiresAt !== undefined) {
    out.push({
      op: "or",
      conditions: [
        { op: "isNull", field: expiresAt, value: true },
        { op: "gt", field: expiresAt, value: now },
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
    if (Array.isArray(grantee.through)) {
      const path = relationHops(grantee, resource, options.resources);
      if (path === undefined || target === undefined) {
        return undefined;
      }
      return compact<RelatedCondition>({
        op: "related",
        resource: target.name,
        relation: grantee.relation,
        field: path.field,
        depth: path.depth,
        hops: path.hops,
        ...(resource === undefined ? {} : linkStop(resource, firstLink(path))),
        passRestricted: path.depth > 0 ? passesRestricted(target) : undefined,
      });
    }
    const start = relationStart(grantee, resource, target);
    if (start === undefined || target === undefined) {
      return undefined;
    }
    return compact<RelatedCondition>({
      op: "related",
      resource: target.name,
      relation: grantee.relation,
      field: start.field,
      depth: start.depth,
      parent: start.parent ? true : undefined,
      restricted:
        start.parent || start.depth > 0
          ? restrictedFor(resource, "parent")
          : undefined,
      passRestricted: start.depth > 0 ? passesRestricted(target) : undefined,
    });
  }
  const spec = resource?.relations?.[grantee.relation];
  if (spec === undefined || isEdgeRelation(spec)) {
    return undefined;
  }
  if (spec.includes !== undefined && options.includes !== false) {
    const parts = expandRelation(resource, grantee.relation).flatMap((name) => {
      const part = relationCondition(
        { ...grantee, relation: name },
        resource,
        scopes,
        { ...options, includes: false },
      );
      return part === undefined ? [] : [part];
    });
    return sole(parts) ?? { op: "or", conditions: parts };
  }
  if (isComputedRelation(spec)) {
    return undefined;
  }
  if (isPrincipalRelation(spec)) {
    const owner: Condition = {
      op: "eq",
      field: spec.principal,
      value: { ref: "principal.id" },
    };
    const period = periodConditions(spec, options.now ?? { date: isoNow() });
    return period.length === 0
      ? owner
      : { op: "and", conditions: [owner, ...period] };
  }
  if (spec.memberOf !== undefined) {
    const scope = resolveScope(scopes, spec.memberOf);
    if (scope === undefined) {
      return { op: "or", conditions: [] };
    }
    if (scope === rootScope(scopes)) {
      return {
        op: "eq",
        field: spec.field,
        value: { ref: "principal.tenant" },
      };
    }
    return { op: "memberOf", scope, field: spec.field, roles: [] };
  }
  return { op: "eq", field: spec.field, value: { ref: "principal.id" } };
}

export function inheritCondition(
  grantee: InheritGrantee,
  resource: ResourceNode | undefined,
  resources: ReadonlyMap<string, ResourceNode> | undefined,
): RelatedCondition | undefined {
  if (resource === undefined) {
    return undefined;
  }
  if (grantee.through === "parent") {
    const parent = resource.parent;
    if (parent === undefined || parent.resource !== grantee.resource) {
      return undefined;
    }
    return compact<RelatedCondition>({
      op: "related",
      resource: grantee.resource,
      relation: "",
      permission: grantee.permission,
      field: parent.field,
      depth: 0,
      parent: true,
      restricted: restrictedFor(resource, "parent"),
    });
  }
  const path = relationHops(
    {
      kind: "relation",
      resource: grantee.resource,
      relation: "",
      through: grantee.through,
    },
    resource,
    resources,
  );
  if (path === undefined) {
    return undefined;
  }
  return compact<RelatedCondition>({
    op: "related",
    resource: grantee.resource,
    relation: "",
    permission: grantee.permission,
    field: path.field,
    depth: 0,
    hops: path.hops,
    ...linkStop(resource, firstLink(path)),
  });
}

function firstLink(path: { readonly hops: readonly RelatedHop[] }): string {
  return path.hops[0]?.link ?? "";
}

function targetMap(
  target: ResourceNode | undefined,
): ReadonlyMap<string, ResourceNode> | undefined {
  return target === undefined ? undefined : new Map([[target.name, target]]);
}
