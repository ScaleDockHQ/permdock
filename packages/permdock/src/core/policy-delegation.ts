import type {
  DefinePolicyOptions,
  DelegationInput,
  DelegationTarget,
  PolicyDelegation,
  PolicyOAuthScope,
} from "./policy-types.ts";
import type { Principal } from "./subject.ts";

import { compact } from "./compact.ts";
import { flattenPermissions } from "./grant-builders.ts";
import { asGrantee, flattenGrantee } from "./grantee.ts";
import {
  type Permission,
  type PermissionTree,
  annotationsFor,
  findPermission,
  listPermissions,
} from "./permissions.ts";
import { normalizeValidity } from "./validity.ts";

function delegationTarget(
  to: DelegationInput["to"],
  index: number,
): DelegationTarget {
  if (typeof to === "string") {
    return { kind: to };
  }
  if ("actor" in to) {
    return { kind: to.actor };
  }
  const target = compact<DelegationTarget>({
    kind: to.kind,
    id: to.id,
    client: to.client,
  });
  if (typeof target.kind !== "string" || target.kind === "") {
    throw new Error(
      `PermDock: delegations[${index}].to needs an actor kind, such as actor('eve')`,
    );
  }
  if (
    target.id !== undefined &&
    (typeof target.id !== "string" || target.id === "")
  ) {
    throw new Error(
      `PermDock: delegations[${index}].to.id must be a non-empty string`,
    );
  }
  if (
    target.client !== undefined &&
    (typeof target.client !== "string" || target.client === "")
  ) {
    throw new Error(
      `PermDock: delegations[${index}].to.client must be a non-empty string`,
    );
  }
  if (target.id !== undefined && target.client !== undefined) {
    throw new Error(
      `PermDock: delegations[${index}].to names both an id and a client; name one`,
    );
  }
  return target;
}

export function normalizeDelegation(
  input: DelegationInput,
  index: number,
  tree: PermissionTree,
): PolicyDelegation {
  const label = `delegations[${index}]`;
  const from = asGrantee(input.from);
  const items = flattenGrantee(from);
  if (items.length === 0) {
    throw new Error(`PermDock: ${label}.from names nobody`);
  }
  if (
    items.some((item) => item.kind === "relation" || item.kind === "inherit")
  ) {
    throw new Error(
      `PermDock: ${label}.from names a relation or inherit(); a delegation is matched without a row, so name a role or another subject-only grantee`,
    );
  }
  if (items.some((item) => item.kind === "actor")) {
    throw new Error(
      `PermDock: ${label}.from names an actor; the principal hands over, the actor is \`to\``,
    );
  }
  const leaves = new Map<string, Permission>();
  for (const leaf of input.permissions.flatMap((item) =>
    flattenPermissions(item),
  )) {
    if (findPermission(tree, leaf.key) === undefined) {
      throw new Error(
        `PermDock: ${label} names unknown permission '${leaf.key}'`,
      );
    }
    leaves.set(leaf.key, leaf);
  }
  const keys = [...leaves.keys()].toSorted();
  if (keys.length === 0) {
    throw new Error(`PermDock: ${label}.permissions is empty`);
  }
  return compact<PolicyDelegation>({
    from,
    to: delegationTarget(input.to, index),
    permissions: keys,
    readOnly: [...leaves.values()]
      .filter((leaf) => annotationsFor(leaf).readOnlyHint)
      .map((leaf) => leaf.key)
      .toSorted(),
    validity: normalizeValidity(input, label),
  });
}

/** RFC 6749 section 3.3 `scope-token`: printable ASCII without space, `"` or `\`. */
function isScopeToken(value: string): boolean {
  return /^[!#-[\]-~]+$/u.test(value);
}

export function normalizeOAuthScopes(
  input: DefinePolicyOptions<unknown, Principal>["oauthScopes"],
  tree: PermissionTree,
): readonly PolicyOAuthScope[] {
  if (input === undefined) {
    return [];
  }
  const own = new Set(listPermissions(tree).map((leaf) => leaf.scope));
  return Object.entries(input).map(([scope, items]) => {
    if (!isScopeToken(scope)) {
      throw new Error(
        `PermDock: oauthScopes key '${scope}' is not an OAuth scope token`,
      );
    }
    if (own.has(scope)) {
      throw new Error(
        `PermDock: oauthScopes key '${scope}' is a permission's own scope`,
      );
    }
    const leaves = new Map<string, Permission>();
    for (const leaf of (Array.isArray(items) ? items : []).flatMap(
      (item: Permission | PermissionTree) => flattenPermissions(item),
    )) {
      if (findPermission(tree, leaf.key) === undefined) {
        throw new Error(
          `PermDock: oauthScopes '${scope}' names unknown permission '${leaf.key}'`,
        );
      }
      leaves.set(leaf.key, leaf);
    }
    if (leaves.size === 0) {
      throw new Error(`PermDock: oauthScopes '${scope}' covers no permission`);
    }
    const sorted = [...leaves.values()].toSorted((a, b) =>
      a.key.localeCompare(b.key),
    );
    return {
      scope,
      permissions: sorted.map((leaf) => leaf.key),
      scopes: sorted.map((leaf) => leaf.scope),
    };
  });
}
