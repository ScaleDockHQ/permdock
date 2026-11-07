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
import { jsonSchemaOf } from "../catalog-doc.ts";
import { dialectsFor } from "./dialects.ts";

/**
 * A condition a worker can clone. A closure or any other non-portable grant
 * keeps the permission key and drops the function.
 */
export type ConditionBranch =
  | { readonly portable: false; readonly key: string }
  | {
      readonly portable: true;
      readonly condition: Condition;
      /** `null` when the default context cannot compile it. */
      readonly rls: string | null;
      /** Sync Streams text; `null` when `rls` is. */
      readonly stream: string | null;
    };

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
  /**
   * The resource schema as JSON Schema 2020-12 through `~standard.jsonSchema`.
   * `null` when the schema library has no JSON Schema export, or the resource
   * has no schema; a schema plugin skips such a resource.
   */
  readonly schema: Readonly<Record<string, unknown>> | null;
  /** The resource's `meta`, JSON only. */
  readonly meta: Readonly<Record<string, unknown>>;
};

/**
 * The compiled policy every plugin reads. No functions, maps or schemas, so a
 * worker can return it with `structuredClone`. A portable `where` carries the
 * RLS text and the Sync Streams text of that one condition.
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

function branchOf(
  grant: Grant,
  scopes: readonly Scope[],
): ConditionBranch | undefined {
  if (grant.portable === false || grant.closure !== undefined) {
    return { portable: false, key: grant.permission.key };
  }
  if (grant.where === undefined) {
    return undefined;
  }
  const dialects = dialectsFor(grant.where, scopes);
  return {
    portable: true,
    condition: grant.where,
    rls: dialects?.rls ?? null,
    stream: dialects?.stream ?? null,
  };
}

function grantOf(grant: Grant, scopes: readonly Scope[]): ModelGrant {
  const where = branchOf(grant, scopes);
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

/**
 * A plain copy. Level records are proxies, and `structuredClone` cannot read
 * them; JSON can.
 */
function plainData<T>(value: T): T {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new TypeError("policy model value is not JSON");
  }
  // SAFETY: JSON.stringify walked `value`, so the parse is the same JSON type.
  return JSON.parse(text) as T;
}

function schemaOf(
  node: ResourceNode,
): Readonly<Record<string, unknown>> | null {
  const schema = jsonSchemaOf(node);
  return schema !== null && typeof schema === "object" && !Array.isArray(schema)
    ? plainData(Object.fromEntries(Object.entries(schema)))
    : null;
}

function resourceOf(node: ResourceNode): ModelResource {
  return compact<ModelResource>({
    name: node.name,
    id: node.id,
    parent: node.parent,
    relations: node.relations,
    links: node.links,
    levels: node.levels === undefined ? undefined : plainData(node.levels),
    orderedLevels: node.orderedLevels,
    instanceActions: [...node.instanceActions].toSorted(),
    collectionActions: [...node.collectionActions].toSorted(),
    schema: schemaOf(node),
    meta: plainData({ ...node.meta }),
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
      grants: binding.grants.map((grant) => grantOf(grant, policy.scopes)),
    })),
    grants: grantList(policy)
      .filter((grant) => grant.role === null)
      .map((grant) => grantOf(grant, policy.scopes)),
    scopes: policy.scopes.map((scope) => ({ ...scope })),
    resources,
    levels: plainData(policy.levels ?? {}),
    orderedLevels: policy.orderedLevels ?? [],
    seeds: null,
  };
  return freezeDeep(structuredClone(draft));
}
