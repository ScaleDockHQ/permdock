import type {
  PermissionsOptions,
  Permission,
  PermissionTree,
  RegistryTree,
  ResourceInit,
  ResourceLevel,
  ResourceLink,
  ResourceNode,
  ResourceRelation,
} from "./permission-types.ts";

import { NODE_RESOURCE, TREE_LEAVES, TREE_REGISTRY } from "./brands.ts";
import { freezeDeep } from "./freeze.ts";
import { MAX_GROUP_DEPTH, assertSafeKey } from "./paths.ts";
import {
  actionNames,
  isResourceInit,
  makeLeaf,
  metaFor,
  resourceMetaFor,
} from "./permission-leaf.ts";
import {
  LEVEL_NAME,
  RESOURCE_NAME,
  assertIncludes,
  normaliseRelation,
  restrictedStopsOf,
} from "./resource-relations.ts";

type BuildContext = {
  readonly former: ReadonlyMap<string, readonly string[]>;
  readonly x: PermissionsOptions<unknown, unknown>["x"];
};

function materialiseResource(
  init: ResourceInit,
  path: readonly string[],
  registry: Map<string, ResourceNode>,
  leaves: Permission[],
  build: BuildContext,
): PermissionTree {
  const { former } = build;
  const segment = path.at(-1);
  if (segment === undefined) {
    throw new Error(
      "PermDock: resource() cannot be the root of definePermissions",
    );
  }
  const name = init.options.name ?? segment;
  assertSafeKey(name, "resource");
  if (init.options.name !== undefined && !RESOURCE_NAME.test(name)) {
    throw new Error(
      `PermDock: resource name '${name}' must start with a letter and hold only letters, digits, '_' and '-'`,
    );
  }
  if (registry.has(name)) {
    throw new Error(`PermDock: duplicate resource name '${name}'`);
  }
  const prefix = path.join(".");
  const instanceNames = actionNames(init.options.actions);
  const collectionNames = actionNames(init.options.collection);
  if (instanceNames.length === 0 && collectionNames.length === 0) {
    throw new Error(
      `PermDock: resource '${name}' has no actions or collection`,
    );
  }
  const instanceSet = new Set<string>();
  const collectionSet = new Set<string>();
  const node: Record<string, Permission> = {};
  for (const action of instanceNames) {
    assertSafeKey(action, "action");
    if (instanceSet.has(action)) {
      throw new Error(`PermDock: duplicate action '${action}' on '${name}'`);
    }
    instanceSet.add(action);
    const key = `${prefix}.${action}`;
    const leaf = makeLeaf(
      key,
      name,
      action,
      metaFor(init.options.actions, action, build.x?.permission),
      "instance",
      former.get(key),
    );
    node[action] = leaf;
    leaves.push(leaf);
  }
  for (const action of collectionNames) {
    assertSafeKey(action, "action");
    if (instanceSet.has(action) || collectionSet.has(action)) {
      throw new Error(`PermDock: duplicate action '${action}' on '${name}'`);
    }
    collectionSet.add(action);
    const key = `${prefix}.${action}`;
    const leaf = makeLeaf(
      key,
      name,
      action,
      metaFor(init.options.collection, action, build.x?.permission),
      "collection",
      former.get(key),
    );
    node[action] = leaf;
    leaves.push(leaf);
  }
  const parent = init.options.parent;
  if (parent !== undefined) {
    assertSafeKey(parent.field, "parent field");
    assertSafeKey(parent.resource, "parent resource");
  }
  const version = init.options.version;
  if (version !== undefined) {
    assertSafeKey(version, "version field");
  }
  const restrictedOption = init.options.restricted;
  const restricted =
    typeof restrictedOption === "string"
      ? restrictedOption
      : restrictedOption?.field;
  if (restrictedOption !== undefined) {
    if (typeof restricted !== "string") {
      throw new TypeError(
        `PermDock: resource "${name}" restricted must name a field`,
      );
    }
    assertSafeKey(restricted, "restricted field");
  }
  const disclosure = init.options.disclosure ?? "reveal";
  if (disclosure !== "hide" && disclosure !== "reveal") {
    throw new Error(
      `PermDock: resource "${name}" disclosure must be 'hide' or 'reveal'`,
    );
  }
  const relations: Record<string, ResourceRelation> = {};
  for (const [relationName, spec] of Object.entries(
    init.options.relations ?? {},
  )) {
    assertSafeKey(relationName, "relation");
    relations[relationName] = freezeDeep(
      normaliseRelation(name, relationName, spec),
    );
  }
  const links: Record<string, ResourceLink> = {};
  for (const [linkName, link] of Object.entries(init.options.links ?? {})) {
    assertSafeKey(linkName, "link");
    if (linkName === "parent") {
      throw new Error(
        `PermDock: link 'parent' on '${name}' is reserved; declare it as parent`,
      );
    }
    assertSafeKey(link.field, "link field");
    assertSafeKey(link.resource, "link resource");
    links[linkName] = freezeDeep({
      field: link.field,
      resource: link.resource,
    });
  }
  const restrictedStopList =
    typeof restrictedOption === "object"
      ? restrictedStopsOf(name, restrictedOption, parent, links)
      : undefined;
  const levels: Record<string, ResourceLevel> = {};
  for (const [levelName, condition] of Object.entries(
    init.options.levels ?? {},
  )) {
    if (!LEVEL_NAME.test(levelName)) {
      throw new Error(
        `PermDock: level '${levelName}' on '${name}' must match ^[a-z][a-z0-9_]*$`,
      );
    }
    if (
      condition === null ||
      typeof condition !== "object" ||
      Array.isArray(condition)
    ) {
      throw new Error(
        `PermDock: level '${levelName}' on '${name}' must be a condition object`,
      );
    }
    levels[levelName] = freezeDeep({ ...condition });
  }
  if (Object.keys(levels).length > 0 && instanceSet.size === 0) {
    throw new Error(
      `PermDock: resource '${name}' declares levels but no instance actions`,
    );
  }
  const ordered = init.options.orderedLevels;
  if (ordered !== undefined && ordered !== true) {
    throw new Error(
      `PermDock: orderedLevels on '${name}' must be true when set`,
    );
  }
  if (ordered === true && Object.keys(levels).length < 2) {
    throw new Error(
      `PermDock: resource '${name}' sets orderedLevels with fewer than two levels`,
    );
  }
  const meta = resourceMetaFor(name, init.options.meta, build.x?.resource);
  const resourceNode: ResourceNode = Object.freeze({
    ...(meta === undefined ? {} : { meta }),
    name,
    path: prefix,
    schema: init.schema,
    id: init.options.id ?? "id",
    parent: parent === undefined ? undefined : freezeDeep({ ...parent }),
    links: freezeDeep(links),
    relations: freezeDeep(relations),
    version,
    restricted,
    ...(restrictedStopList === undefined
      ? {}
      : { restrictedStops: restrictedStopList }),
    disclosure,
    instanceActions: instanceSet,
    collectionActions: collectionSet,
    levels: Object.freeze(levels),
    ...(ordered === true ? { orderedLevels: true as const } : {}),
  });
  assertIncludes(resourceNode);
  registry.set(name, resourceNode);
  Object.defineProperty(node, NODE_RESOURCE, {
    value: resourceNode,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return freezeDeep(node);
}

/**
 * The resource a `definePermissions` resource node was built from, read from
 * the node itself.
 */
export function resourceOfNode(
  node: PermissionTree | Permission,
): ResourceNode | undefined {
  if (!Object.hasOwn(node, NODE_RESOURCE)) {
    return undefined;
  }
  const value: unknown = Reflect.get(node, NODE_RESOURCE);
  return isResourceNode(value) ? value : undefined;
}

function isResourceNode(value: unknown): value is ResourceNode {
  return (
    value !== null &&
    typeof value === "object" &&
    "name" in value &&
    "instanceActions" in value
  );
}

export function walk(
  input: unknown,
  path: readonly string[],
  registry: Map<string, ResourceNode>,
  leaves: Permission[],
  depth: number,
  build: BuildContext,
): PermissionTree {
  if (depth > MAX_GROUP_DEPTH) {
    throw new Error(
      `PermDock: permission group nesting exceeds ${MAX_GROUP_DEPTH}`,
    );
  }
  if (isResourceInit(input)) {
    return materialiseResource(input, path, registry, leaves, build);
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(
      `PermDock: definePermissions expected a group or resource at '${path.join(".")}'`,
    );
  }
  const group: Record<string, PermissionTree | Permission> = {};
  for (const key of Object.keys(input)) {
    assertSafeKey(key, "group");
    // SAFETY: input is a non-null, non-array object checked above; key is one of its own keys.
    group[key] = walk(
      (input as Record<string, unknown>)[key],
      [...path, key],
      registry,
      leaves,
      depth + 1,
      build,
    );
  }
  return group;
}

export function attachRegistry(
  tree: PermissionTree,
  registry: ReadonlyMap<string, ResourceNode>,
  leaves: readonly Permission[],
): RegistryTree {
  // SAFETY: both RegistryTree symbol properties are defined on the tree right below.
  const attached = tree as RegistryTree;
  Object.defineProperty(attached, TREE_REGISTRY, {
    value: registry,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(attached, TREE_LEAVES, {
    value: Object.freeze([...leaves]),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return attached;
}
