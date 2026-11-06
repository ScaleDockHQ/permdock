import type { Condition } from "../../conditions/ast.ts";
import type { ResourceNode } from "../../core/permission-types.ts";
import type { Grant, Policy, RoleBinding } from "../../core/policy-types.ts";
import type { Scope } from "../../core/scopes.ts";

import { compact } from "../../core/compact.ts";
import { freezeDeep } from "../../core/freeze.ts";
import {
  getRegistry,
  isRegistryTree,
  listPermissions,
} from "../../core/permission-registry.ts";
import { grantList } from "../../core/policy.ts";

/**
 * A condition a worker can clone. A closure or any other non-portable grant
 * keeps the permission key and drops the function.
 */
export type ConditionBranch =
  | { readonly portable: false; readonly key: string }
  | { readonly portable: true; readonly condition: Condition };

/** One permission leaf. The same five fields as the public leaf, and no methods. */
export type ModelPermission = {
  readonly key: string;
  readonly resource: string;
  readonly action: string;
  readonly scope: string;
  readonly meta: Readonly<Record<string, unknown>>;
};

export type ModelGrant = {
  readonly permission: string;
  readonly effect: "allow" | "deny";
  readonly role: string | null;
  readonly scope: Grant["scope"];
  readonly where?: ConditionBranch;
  readonly level?: string;
};

export type ModelRole = {
  readonly name: string;
  readonly scope: string;
  readonly assignable: boolean;
  readonly grants: readonly ModelGrant[];
};

export type ModelResource = {
  readonly name: string;
  readonly id: string;
  readonly parent?: { readonly field: string; readonly resource: string };
  readonly relations: ResourceNode["relations"];
  readonly links: ResourceNode["links"];
  readonly levels?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly orderedLevels?: true;
  readonly instanceActions: readonly string[];
  readonly collectionActions: readonly string[];
};

/**
 * The compiled policy every plugin reads. No functions, maps or schemas, so a
 * worker can return it with `structuredClone`. RLS and stream SQL are compiled
 * from `where` by the plugins, from this one branch.
 */
export type PolicyModel = {
  readonly v: 1;
  readonly permissions: readonly ModelPermission[];
  readonly roles: readonly ModelRole[];
  /** Grants that belong to no role. */
  readonly grants: readonly ModelGrant[];
  readonly scopes: readonly Scope[];
  readonly resources: readonly ModelResource[];
  readonly levels: Readonly<
    Record<string, Readonly<Record<string, Condition>>>
  >;
  readonly orderedLevels: readonly string[];
  /** Filled when the project exports `defineSeeds`; absent until then. */
  readonly seeds: null;
};

function branchOf(grant: Grant): ConditionBranch | undefined {
  if (grant.portable === false || grant.closure !== undefined) {
    return { portable: false, key: grant.permission.key };
  }
  if (grant.where === undefined) {
    return undefined;
  }
  return { portable: true, condition: grant.where };
}

function grantOf(grant: Grant): ModelGrant {
  const where = branchOf(grant);
  return compact<ModelGrant>({
    permission: grant.permission.key,
    effect: grant.effect,
    role: grant.role,
    scope: grant.scope,
    where,
    level: grant.level,
  });
}

function roleScope(binding: RoleBinding): string {
  if (typeof binding.on === "string") {
    return binding.on;
  }
  return binding.on === undefined ? "global" : "resource";
}

function resourceOf(node: ResourceNode): ModelResource {
  return compact<ModelResource>({
    name: node.name,
    id: node.id,
    parent: node.parent,
    relations: node.relations,
    links: node.links,
    levels: node.levels,
    orderedLevels: node.orderedLevels,
    instanceActions: [...node.instanceActions].toSorted(),
    collectionActions: [...node.collectionActions].toSorted(),
  });
}

/** Builds the model once per run. The result is frozen and clone-safe. */
export function policyModel(policy: Policy): PolicyModel {
  const resources = isRegistryTree(policy.permissions)
    ? [...getRegistry(policy.permissions).values()].map(resourceOf)
    : [];
  const draft: PolicyModel = {
    v: 1,
    permissions: listPermissions(policy.permissions).map((leaf) => ({
      key: leaf.key,
      resource: leaf.resource,
      action: leaf.action,
      scope: leaf.scope,
      meta: leaf.meta,
    })),
    roles: policy.roles.map((binding) => ({
      name: binding.name,
      scope: roleScope(binding),
      assignable: binding.assignable,
      grants: binding.grants.map(grantOf),
    })),
    grants: grantList(policy)
      .filter((grant) => grant.role === null)
      .map(grantOf),
    scopes: policy.scopes.map((scope) => ({ ...scope })),
    resources,
    levels: policy.levels ?? {},
    orderedLevels: policy.orderedLevels ?? [],
    seeds: null,
  };
  return freezeDeep(structuredClone(draft));
}
