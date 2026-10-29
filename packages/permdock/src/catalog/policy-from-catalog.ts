import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { Condition } from "../conditions/ast.ts";
import type {
  ActionList,
  ActionMeta,
  PermissionTree,
  ResourceNode,
  ResourceOptions,
} from "../core/permission-types.ts";
import type {
  ActivationSpec,
  DelegationInput,
  Grant,
  Policy,
  PolicyDelegation,
  RoleBinding,
  RoleScope,
} from "../core/policy-types.ts";
import type { Principal } from "../core/subject.ts";
import type { PushedGrant, PushedPolicy } from "./pushed-policy.ts";
import type {
  CatalogDocument,
  CatalogPermission,
  CatalogResource,
  CatalogRole,
} from "./types.ts";

import { normalizeWhere } from "../conditions/normalize.ts";
import { readWireApproval } from "../core/approval-normalize.ts";
import { compact } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { isPortableCondition } from "../core/hosted.ts";
import { resource } from "../core/permission-leaf.ts";
import { getRegistry, findPermission } from "../core/permission-registry.ts";
import { definePermissions } from "../core/permissions.ts";
import { normalizeDelegation } from "../core/policy-delegation.ts";
import { indexPolicy } from "../core/policy.ts";
import { defineScopes } from "../core/scopes.ts";
import { PermDockValidationError } from "../core/validation-error.ts";
import { readWireValidity } from "../core/validity.ts";
import { definePlans, defineRoles } from "../core/vocabulary.ts";
import { resourceSchemaFromJson } from "./json-schema-validator.ts";
import { parseCatalog } from "./parse.ts";
import { parsePushedPolicy } from "./pushed-policy.ts";

export type PolicyFromCatalogOptions<TUser = unknown> = {
  /** Maps the request's user to the subject; the identity function when absent. */
  readonly subject?: (user: TUser) => Principal | null;
};

/**
 * Stands in for a condition that only code can evaluate: an allow that holds it
 * never matches and a deny that holds it always applies.
 */
const CODE_CONDITION: Condition = freezeDeep({
  op: "opaque",
  sql: "",
  fingerprint: "permdock:closure",
});

function invalid(message: string, cause?: unknown): never {
  throw new PermDockValidationError({
    code: "invalid-data",
    permission: "",
    resource: "",
    boundary: "catalog",
    issues: [{ message }],
    message: `PermDock: policyFromCatalog: ${message}`,
    ...(cause === undefined ? {} : { cause }),
  });
}

function actionsOf(
  permissions: readonly CatalogPermission[],
  arity: CatalogPermission["arity"],
): Record<string, ActionMeta> | undefined {
  const entries = permissions
    .filter((leaf) => leaf.arity === arity)
    .map((leaf): [string, ActionMeta] => [leaf.action, { ...leaf.meta }]);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function resourceInit(
  name: string,
  entry: CatalogResource,
  permissions: readonly CatalogPermission[],
): unknown {
  const options = compact<ResourceOptions<ActionList, ActionList>>({
    name,
    id: entry.id,
    actions: actionsOf(permissions, "instance"),
    collection: actionsOf(permissions, "collection"),
    parent: entry.parent,
    links: entry.links,
    disclosure: entry.disclosure,
    // SAFETY: the catalog carries relations in the normalised form resource() accepts as input.
    relations: entry.relations as ResourceOptions["relations"],
    version: entry.version,
    restricted:
      entry.restricted === undefined
        ? undefined
        : entry.restrictedStops === undefined
          ? entry.restricted
          : { field: entry.restricted, stops: entry.restrictedStops },
    // SAFETY: catalog resource meta is the ResourceMeta definePermissions wrote, validated by the catalog schema.
    meta: entry.meta as ResourceOptions["meta"],
  });
  const schema: StandardSchemaV1 | undefined = resourceSchemaFromJson(
    entry.schema,
  );
  return schema === undefined ? resource(options) : resource(schema, options);
}

function setPath(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
  key: string,
): void {
  let node = root;
  for (const segment of path.slice(0, -1)) {
    const next = Object.hasOwn(node, segment) ? node[segment] : undefined;
    if (next === undefined) {
      const child: Record<string, unknown> = {};
      node[segment] = child;
      node = child;
    } else if (
      typeof next === "object" &&
      next !== null &&
      Object.getOwnPropertySymbols(next).length === 0
    ) {
      // SAFETY: only this function writes groups into the input, as plain records.
      node = next as Record<string, unknown>;
    } else {
      invalid(`permission '${key}' nests under another resource`);
    }
  }
  const last = path.at(-1);
  if (last === undefined || Object.hasOwn(node, last)) {
    invalid(`permission '${key}' collides with another resource path`);
  }
  node[last] = value;
}

function permissionTree(catalog: CatalogDocument): PermissionTree {
  const byResource = new Map<string, CatalogPermission[]>();
  for (const leaf of catalog.permissions) {
    byResource.set(leaf.resource, [
      ...(byResource.get(leaf.resource) ?? []),
      leaf,
    ]);
  }
  const input: Record<string, unknown> = {};
  const renamed: Record<string, string> = {};
  for (const [name, leaves] of byResource) {
    const entry = Object.hasOwn(catalog.resources, name)
      ? catalog.resources[name]
      : undefined;
    const first = leaves[0];
    if (entry === undefined || first === undefined) {
      invalid(`resource '${name}' is missing from catalog.resources`);
    }
    const suffix = `.${first.action}`;
    if (!first.key.endsWith(suffix)) {
      invalid(`permission '${first.key}' does not end in its action`);
    }
    const path = first.key.slice(0, -suffix.length).split(".");
    for (const leaf of leaves) {
      if (leaf.key !== `${path.join(".")}.${leaf.action}`) {
        invalid(`permission '${leaf.key}' sits apart from resource '${name}'`);
      }
      for (const former of leaf.renamedFrom ?? []) {
        renamed[former] = leaf.key;
      }
    }
    setPath(input, path, resourceInit(name, entry, leaves), first.key);
  }
  try {
    return definePermissions(input, { renamed });
  } catch (error) {
    return invalid(
      error instanceof Error ? error.message : "invalid permission tree",
      error,
    );
  }
}

/**
 * A portable grant's condition must be in the portable subset; a non-portable
 * one is read as written and fails closed where it cannot evaluate.
 */
function condition(
  value: unknown,
  label: string,
  portable: boolean,
): Condition | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (portable && !isPortableCondition(value)) {
    return invalid(`${label} is not a portable condition`);
  }
  try {
    return normalizeWhere(value);
  } catch (error) {
    return invalid(`${label} is not a valid condition`, error);
  }
}

function buildGrant(tree: PermissionTree, raw: PushedGrant): Grant {
  const permission = findPermission(tree, raw.permission);
  if (permission === undefined || permission.key !== raw.permission) {
    invalid(`grant names unknown permission '${raw.permission}'`);
  }
  const validity = readWireValidity(raw.validity, raw.effect);
  const where =
    raw.closure === true
      ? CODE_CONDITION
      : condition(
          raw.where,
          `grant '${raw.permission}' where`,
          raw.portable !== false,
        );
  return freezeDeep(
    compact<Grant>({
      permission,
      effect: raw.effect,
      to: raw.to,
      role: raw.role,
      where,
      check: condition(
        raw.check,
        `grant '${raw.permission}' check`,
        raw.portable !== false,
      ),
      approval: readWireApproval(raw.approval),
      portable: raw.portable !== false,
      limit: raw.limit,
      fields: raw.fields,
      scope: raw.scope ?? "global",
      name: raw.name,
      meta: raw.meta,
      obligations: raw.obligations,
      purpose: raw.purpose,
      breakGlass: raw.breakGlass,
      viaOnly: raw.viaOnly,
      validity,
      requires: raw.requires,
    }),
  );
}

function roleOn(
  role: CatalogRole | undefined,
  grants: readonly Grant[],
  resources: ReadonlyMap<string, ResourceNode>,
  tree: PermissionTree,
): RoleScope | undefined {
  if (role?.on === undefined) {
    return undefined;
  }
  if (role.on !== "resource") {
    return role.on;
  }
  const names = [
    ...new Set(
      grants.flatMap((grant) =>
        typeof grant.scope === "object" ? [grant.scope.resource] : [],
      ),
    ),
  ];
  const nodes = names.flatMap((name): PermissionTree[] => {
    const node = resources.get(name);
    const first = node === undefined ? undefined : leafOf(tree, node);
    return first === undefined ? [] : [first];
  });
  return nodes.length === 1 ? nodes[0] : nodes;
}

/** The subtree of `node`: its path walked from the root of `tree`. */
function leafOf(
  tree: PermissionTree,
  node: ResourceNode,
): PermissionTree | undefined {
  let current: unknown = tree;
  for (const segment of node.path.split(".")) {
    current =
      typeof current === "object" &&
      current !== null &&
      Object.hasOwn(current, segment)
        ? Reflect.get(current, segment)
        : undefined;
  }
  // SAFETY: a registry node's path names a subtree definePermissions built.
  return current as PermissionTree | undefined;
}

function activationOf(role: CatalogRole): ActivationSpec | undefined {
  const activation = role.activation;
  if (activation === undefined) {
    return undefined;
  }
  return compact<ActivationSpec>({
    maxDuration: activation.maxDuration,
    justification: activation.justification,
    approval: activation.approval === true ? "human" : undefined,
    assurance: activation.assurance,
  });
}

function binding(
  name: string,
  role: CatalogRole | undefined,
  grants: readonly Grant[],
  on: RoleScope | undefined,
): RoleBinding {
  return freezeDeep(
    compact<RoleBinding>({
      name,
      grants,
      on,
      assignable: role?.assignable ?? on !== undefined,
      exclusiveWith: role?.exclusiveWith,
      min: role?.min,
      max: role?.max,
      transferOnly: role?.transferOnly,
      assigns: role?.assigns,
      for: role?.for,
      meta:
        role?.audience === undefined ? undefined : { audience: role.audience },
      activation: role === undefined ? undefined : activationOf(role),
      // A catalog does not say who may consent, so nobody can open a support session here.
      support:
        role?.supportAccess === undefined
          ? undefined
          : {
              role: name,
              actorRequired: role.supportAccess.actorRequired,
              consent: { by: [], durations: role.supportAccess.durations },
              group: role.supportAccess.group,
            },
    }),
  );
}

function delegationsOf(
  catalog: CatalogDocument,
  tree: PermissionTree,
): readonly PolicyDelegation[] | undefined {
  if (catalog.delegations === undefined) {
    return undefined;
  }
  return catalog.delegations.map((entry, index) => {
    const permissions = entry.permissions.map((key) => {
      const leaf = findPermission(tree, key);
      if (leaf === undefined) {
        invalid(
          `delegations[${String(index)}] names unknown permission '${key}'`,
        );
      }
      return leaf;
    });
    // SAFETY: the catalog's delegation from and to are the Grantee and DelegationTarget JSON definePolicy wrote.
    const input = {
      from: entry.from,
      to: entry.to,
      permissions,
      validFrom: entry.validity?.from,
      validUntil: entry.validity?.until,
    } as unknown as DelegationInput;
    try {
      return normalizeDelegation(input, index, tree);
    } catch (error) {
      return invalid(`delegations[${String(index)}] is invalid`, error);
    }
  });
}

function identity<TUser>(user: TUser): Principal | null {
  // SAFETY: without a subject mapper the caller passes the subject itself, as the hosted ADS does.
  return user as Principal | null;
}

/**
 * Rebuilds an evaluable `Policy` from a catalog (`permissions.catalog.json`)
 * and the policy `permdock cloud push` sent with it, for a service that holds
 * no application code: the hosted AuthZEN endpoint or a `mergeHostedGrants`
 * pre-check. Throws `PermDockValidationError` when either input is malformed or
 * the two disagree.
 *
 * What only code can answer fails closed: an allow whose condition is a closure
 * never grants and such a deny always applies; a resource schema keyword
 * outside the supported JSON Schema subset rejects every value; a support role
 * has no one who may consent. Grant levels and OAuth scopes are not in a
 * catalog, so the rebuilt policy has none.
 */
export function policyFromCatalog<TUser = unknown>(
  catalogInput: unknown,
  pushedInput: unknown,
  options: PolicyFromCatalogOptions<TUser> = {},
): Policy<TUser> {
  const catalog = parseCatalog(catalogInput);
  const pushed: PushedPolicy = parsePushedPolicy(pushedInput);
  const permissions = permissionTree(catalog);
  const resources = getRegistry(permissions);
  const scopes = defineScopes(
    pushed.scopes === undefined
      ? catalog.scopes === undefined
        ? undefined
        : Object.fromEntries(
            catalog.scopes.map((scope) => [
              scope.name,
              compact({ key: scope.key, within: scope.within }),
            ]),
          )
      : Object.fromEntries(
          pushed.scopes.map((scope) => [
            scope.name,
            compact({ key: scope.key, within: scope.within }),
          ]),
        ),
  );
  const grants = pushed.grants.map((raw) => buildGrant(permissions, raw));
  const catalogRoles = new Map(
    (catalog.roles ?? []).map((role) => [role.key, role]),
  );
  // The pushed grants keep the policy's role order, which generated SQL follows; the catalog sorts its roles.
  const roleNames = [
    ...new Set([
      ...grants.flatMap((grant) => (grant.role === null ? [] : [grant.role])),
      ...(catalog.roles ?? []).map((role) => role.key),
    ]),
  ];
  const roles = roleNames.flatMap((name) => {
    const role = catalogRoles.get(name);
    const own = grants.filter((grant) => grant.role === name);
    if (
      own.length === 0 &&
      role?.activation === undefined &&
      role?.supportAccess === undefined
    ) {
      return [];
    }
    return [
      binding(name, role, own, roleOn(role, own, resources, permissions)),
    ];
  });
  const vocabulary = freezeDeep({
    permissions,
    roles: defineRoles(
      Object.fromEntries(
        roleNames.map((name) => {
          const role = catalogRoles.get(name);
          return [
            name,
            compact({
              on:
                role?.on === undefined || role.on === "resource"
                  ? undefined
                  : role.on,
              assignable: role?.assignable,
              meta:
                role?.audience === undefined
                  ? undefined
                  : { audience: role.audience },
            }),
          ];
        }),
      ),
    ),
    plans: definePlans(
      Object.fromEntries((catalog.plans ?? []).map((plan) => [plan.key, {}])),
    ),
  });
  const subject = options.subject ?? identity;
  const delegations = delegationsOf(catalog, permissions);
  const hostable = catalog.permissions
    .filter((leaf) => leaf.hostable === true)
    .map((leaf) => leaf.key);
  return freezeDeep(
    compact<Policy<TUser>>({
      permissions,
      roles,
      rolesByName: new Map(roles.map((role) => [role.name, role])),
      grants,
      vocabulary,
      scopes,
      principal: subject,
      subject,
      validate: "boundary",
      fingerprint: pushed.fingerprint,
      resources,
      hostable,
      delegations,
      index: indexPolicy(roles, grants, vocabulary),
    }),
  );
}
