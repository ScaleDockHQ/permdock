import type { Grant, RoleBinding, RoleScope } from "./policy-types.ts";

import { compact } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";
import {
  flattenGrantee,
  inheritCondition,
  isGraphRelation,
  relationHops,
  relationStart,
} from "./grantee.ts";
import {
  type PermissionTree,
  type ResourceNode,
  isFieldRelation,
  isSelfParented,
  listPermissions,
} from "./permissions.ts";
import { type Scope, resolveScope } from "./scopes.ts";
import { memberOfFields, relatesTo, scopeField } from "./tenancy.ts";

export function assertParentGraph(
  resources: ReadonlyMap<string, ResourceNode>,
): void {
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

/**
 * Graph relation grantees must reach their resource: `through: 'parent'` from
 * the row to its parent resource or along its own self-parent, and never over
 * a `memberOf` relation, which is tenancy, not the object graph.
 */
export function assertRelationGrants(
  grants: readonly Grant[],
  resources: ReadonlyMap<string, ResourceNode>,
): void {
  for (const grant of grants) {
    for (const item of flattenGrantee(grant.to)) {
      if (item.kind !== "relation" || !isGraphRelation(item, resources)) {
        continue;
      }
      const label = `grant ${grant.permission.key} relation '${item.relation}'`;
      const target = resources.get(item.resource);
      const spec = target?.relations[item.relation];
      if (target === undefined || spec === undefined) {
        throw new Error(
          `PermDock: ${label}: ${item.resource} does not declare it`,
        );
      }
      if (isFieldRelation(spec) && spec.memberOf !== undefined) {
        throw new Error(
          `PermDock: ${label} is a memberOf relation; through walks the object graph, not scopes`,
        );
      }
      const row = resources.get(grant.permission.resource);
      if (Array.isArray(item.through)) {
        if (relationHops(item, row, resources) === undefined) {
          throw new Error(
            `PermDock: ${label}: the links [${item.through.join(", ")}] from ${grant.permission.resource} do not end on ${target.name}${(item.depth ?? 0) > 0 ? ` (or ${target.name} does not parent itself for depth)` : ""}`,
          );
        }
        continue;
      }
      if (
        item.through === "parent" &&
        target.name === row?.name &&
        !isSelfParented(target)
      ) {
        throw new Error(
          `PermDock: ${label}: through: 'parent' needs ${target.name} to parent itself`,
        );
      }
      if (relationStart(item, row, target) === undefined) {
        throw new Error(
          item.through === undefined
            ? `PermDock: ${label} is on ${target.name}, not ${grant.permission.resource}; add through: 'parent'`
            : `PermDock: ${label}: ${grant.permission.resource} has no parent on ${target.name}`,
        );
      }
    }
  }
}

export function assertInheritGrants(
  grants: readonly Grant[],
  resources: ReadonlyMap<string, ResourceNode>,
  tree: PermissionTree,
): void {
  const keys = new Set(listPermissions(tree).map((leaf) => leaf.key));
  const edges = new Map<string, Set<string>>();
  for (const grant of grants) {
    for (const item of flattenGrantee(grant.to)) {
      if (item.kind !== "inherit") {
        continue;
      }
      const label = `grant ${grant.permission.key} inherit '${item.permission}'`;
      if (grant.effect !== "allow") {
        throw new Error(
          `PermDock: ${label}: inherit() is allowed on an allow only`,
        );
      }
      if (grant.permission.kind !== "instance") {
        throw new Error(
          `PermDock: ${label}: inherit() needs an instance action; a collection action has no row to follow`,
        );
      }
      if (!keys.has(item.permission)) {
        throw new Error(`PermDock: ${label}: the policy does not declare it`);
      }
      if (
        inheritCondition(
          item,
          resources.get(grant.permission.resource),
          resources,
        ) === undefined
      ) {
        throw new Error(
          item.through === "parent"
            ? `PermDock: ${label}: ${grant.permission.resource} has no parent on ${item.resource}`
            : `PermDock: ${label}: the links [${item.through.join(", ")}] from ${grant.permission.resource} do not end on ${item.resource}`,
        );
      }
      const next = edges.get(grant.permission.key) ?? new Set<string>();
      next.add(item.permission);
      edges.set(grant.permission.key, next);
    }
  }
  const done = new Set<string>();
  const visit = (key: string, path: readonly string[]): void => {
    if (path.includes(key)) {
      throw new Error(
        `PermDock: inherit() grants form a cycle: ${[...path.slice(path.indexOf(key)), key].join(" -> ")}`,
      );
    }
    if (done.has(key)) {
      return;
    }
    for (const target of edges.get(key) ?? []) {
      visit(target, [...path, key]);
    }
    done.add(key);
  };
  for (const key of edges.keys()) {
    visit(key, []);
  }
}

function scopeOfGrant(
  scope: Grant["scope"],
  declared: readonly Scope[],
): Grant["scope"] {
  if (typeof scope !== "string" || scope === "global") {
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
  to: Grant["to"],
  declared: readonly Scope[],
): Grant["to"] {
  const items = flattenGrantee(to);
  if (!items.some((item) => item.kind === "role")) {
    return to;
  }
  const mapped = items.map((item) =>
    item.kind === "role"
      ? freezeDeep({ ...item, scope: scopeOfGrant(item.scope, declared) })
      : item,
  );
  if (Array.isArray(to)) {
    return freezeDeep(mapped);
  }
  const [single] = mapped;
  return single ?? to;
}

/** Resolves `tenant` / `team` aliases to declared names; an undeclared scope throws. */
export function rescopeGrant(grant: Grant, declared: readonly Scope[]): Grant {
  const scope = scopeOfGrant(grant.scope, declared);
  const to = rescopeGrantee(grant.to, declared);
  if (scope === grant.scope && to === grant.to) {
    return grant;
  }
  return freezeDeep({ ...grant, scope, to });
}

export function rescopeBinding(
  binding: RoleBinding,
  declared: readonly Scope[],
): RoleBinding {
  const grants = binding.grants.map((grant) => rescopeGrant(grant, declared));
  const on =
    typeof binding.on === "string"
      ? scopeOfGrant(binding.on, declared)
      : binding.on;
  // SAFETY: a string on resolves to a declared scope name; any other on is passed through as is.
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
export function assertScopeKeys(
  grants: readonly Grant[],
  scopes: readonly Scope[],
  resources: ReadonlyMap<string, ResourceNode>,
): void {
  for (const grant of grants) {
    if (
      typeof grant.scope !== "string" ||
      grant.scope === "global" ||
      grant.permission.kind !== "instance"
    ) {
      continue;
    }
    const key = scopes.find((scope) => scope.name === grant.scope)?.key;
    const node = resources.get(grant.permission.resource);
    if (key === undefined || node === undefined) {
      continue;
    }
    const fields = memberOfFields(node, grant.scope, scopes);
    if (fields.length > 1 && !fields.includes(key)) {
      throw new Error(
        `PermDock: resource '${node.name}' declares several memberOf relations to '${grant.scope}' (${fields.join(", ")}); name the one holding the instance with the scope's key '${key}'`,
      );
    }
    const field = scopeField(node, grant.scope, scopes);
    if (field !== undefined && relatesTo(node, field, grant.scope, scopes)) {
      continue;
    }
    throw new Error(
      `PermDock: resource '${node.name}' needs relations: { <name>: { field: '${key}', memberOf: '${grant.scope}' } } for ${grant.permission.key} on '${grant.scope}' roles`,
    );
  }
}

/** A `requires` names a permission the policy declares. */
export function assertRequires(
  grants: readonly Grant[],
  tree: PermissionTree,
): void {
  const keys = new Set(listPermissions(tree).map((leaf) => leaf.key));
  for (const grant of grants) {
    for (const key of grant.requires ?? []) {
      if (!keys.has(key)) {
        throw new Error(
          `PermDock: '${grant.permission.key}' requires '${key}', which the policy does not declare`,
        );
      }
    }
  }
}
