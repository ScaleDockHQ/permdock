import type {
  Permission,
  PermissionTree,
  RegistryTree,
  ResourceMeta,
  ResourceNode,
  ResourceXTree,
} from "./permission-types.ts";

import { TREE_LEAVES, TREE_REGISTRY } from "./brands.ts";
import { freezeDeep } from "./freeze.ts";
import { attachRegistry } from "./materialise-resource.ts";
import { assertSafeKey, isForbiddenKey, ownKeys } from "./paths.ts";
import { formerKeys, formerScopes } from "./permission-leaf.ts";
import { assertGraphTargets } from "./resource-relations.ts";

export function isRegistryTree(tree: PermissionTree): tree is RegistryTree {
  return TREE_REGISTRY in tree;
}

export function getRegistry(
  tree: PermissionTree,
): ReadonlyMap<string, ResourceNode> {
  if (!isRegistryTree(tree)) {
    throw new Error("PermDock: permission tree is missing its registry");
  }
  return tree[TREE_REGISTRY];
}

export function getResource<RX = never>(
  tree: PermissionTree & ResourceXTree<RX>,
  name: string,
):
  | ([RX] extends [never]
      ? ResourceNode
      : ResourceNode & { readonly meta?: ResourceMeta<Readonly<RX>> })
  | undefined;

export function getResource(
  tree: PermissionTree,
  name: string,
): ResourceNode | undefined {
  if (isForbiddenKey(name)) {
    return undefined;
  }
  return getRegistry(tree).get(name);
}

const RENAMED_KEY = /^\S+$/u;

/**
 * Current key to its former keys, from the `renamed` option; targets are
 * checked once leaves exist.
 */
export function formerByKey(
  renamed: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, readonly string[]> {
  const former = new Map<string, string[]>();
  if (renamed === undefined) {
    return former;
  }
  if (renamed === null || typeof renamed !== "object") {
    throw new TypeError("PermDock: renamed must map old keys to current keys");
  }
  for (const [old, current] of Object.entries(renamed)) {
    if (!RENAMED_KEY.test(old) || old.split(".").some(isForbiddenKey)) {
      throw new Error(`PermDock: renamed key '${old}' is not a valid key`);
    }
    if (typeof current !== "string") {
      throw new TypeError(
        `PermDock: renamed key '${old}' must map to a current key`,
      );
    }
    former.set(current, [...(former.get(current) ?? []), old]);
  }
  return former;
}

/**
 * Every current key is unique, every former key names exactly one leaf, and no
 * former key is also a current key, so a string resolves to one leaf.
 */
export function assertKeys(
  leaves: readonly Permission[],
  former?: ReadonlyMap<string, readonly string[]>,
): void {
  const current = new Set<string>();
  for (const leaf of leaves) {
    if (current.has(leaf.key)) {
      /* v8 ignore next */
      throw new Error(`PermDock: duplicate permission key '${leaf.key}'`);
    }
    current.add(leaf.key);
  }
  for (const target of former?.keys() ?? []) {
    if (!current.has(target)) {
      throw new Error(
        `PermDock: renamed target '${target}' is not a permission key`,
      );
    }
  }
  const olds = new Map<string, string>();
  for (const leaf of leaves) {
    for (const old of formerKeys(leaf)) {
      if (current.has(old)) {
        throw new Error(
          `PermDock: renamed key '${old}' is still a permission key`,
        );
      }
      const other = olds.get(old);
      if (other !== undefined && other !== leaf.key) {
        throw new Error(
          `PermDock: renamed key '${old}' maps to both '${other}' and '${leaf.key}'`,
        );
      }
      olds.set(old, leaf.key);
    }
  }
}

function collectLeaves(node: PermissionTree | Permission): Permission[] {
  if ("key" in node && "scope" in node && "action" in node) {
    // SAFETY: a leaf carries key, scope and action; a group built by walk has no such trio.
    return [node as Permission];
  }
  const out: Permission[] = [];
  for (const key of ownKeys(node)) {
    // SAFETY: leaves returned above, so node is a group of trees and leaves.
    const child = (node as PermissionTree)[key];
    if (child !== undefined) {
      out.push(...collectLeaves(child));
    }
  }
  return out;
}

export function listPermissions(
  tree: PermissionTree | Permission,
): readonly Permission[] {
  // SAFETY: isRegistryTree only tests for the TREE_REGISTRY key, which a leaf never has.
  if (isRegistryTree(tree as PermissionTree)) {
    // SAFETY: the guard above found TREE_REGISTRY, which attachRegistry sets with TREE_LEAVES.
    return (tree as RegistryTree)[TREE_LEAVES];
  }
  return collectLeaves(tree);
}

export function findPermission(
  tree: PermissionTree,
  keyOrScope: string,
): Permission | undefined {
  if (isForbiddenKey(keyOrScope)) {
    return undefined;
  }
  const leaves = listPermissions(tree);
  for (const leaf of leaves) {
    if (leaf.key === keyOrScope || leaf.scope === keyOrScope) {
      return leaf;
    }
  }
  for (const leaf of leaves) {
    if (
      formerKeys(leaf).includes(keyOrScope) ||
      formerScopes(leaf).includes(keyOrScope)
    ) {
      return leaf;
    }
  }
  return undefined;
}

/**
 * A permission leaf: string `key`, `scope`, `resource` and `action` plus an
 * object `meta`. `kind` is non-enumerable and does not survive
 * `JSON.stringify`, so a leaf that crossed a serialisation boundary passes
 * without it; when present it must be `instance` or `collection`.
 */
export function isPermission(value: unknown): value is Permission {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  for (const field of ["key", "scope", "resource", "action"] as const) {
    if (
      !Object.hasOwn(value, field) ||
      typeof Reflect.get(value, field) !== "string"
    ) {
      return false;
    }
  }
  const meta: unknown = Object.hasOwn(value, "meta")
    ? Reflect.get(value, "meta")
    : undefined;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    return false;
  }
  if (!Object.hasOwn(value, "kind")) {
    return true;
  }
  const kind: unknown = Reflect.get(value, "kind");
  return kind === "instance" || kind === "collection";
}

function mergeNodes(
  target: Record<string, PermissionTree | Permission>,
  source: PermissionTree,
  keys: Set<string>,
  registry: Map<string, ResourceNode>,
  sourceRegistry: ReadonlyMap<string, ResourceNode> | undefined,
): void {
  for (const key of ownKeys(source)) {
    assertSafeKey(key, "group");
    const incoming = source[key];
    if (incoming === undefined) {
      /* v8 ignore next */
      continue;
    }
    const existing = target[key];
    if (existing === undefined) {
      target[key] = incoming;
      if (isPermission(incoming)) {
        if (keys.has(incoming.key)) {
          /* v8 ignore next */
          throw new Error(
            `PermDock: duplicate permission key '${incoming.key}'`,
          );
        }
        keys.add(incoming.key);
      }
      continue;
    }
    if (isPermission(existing) || isPermission(incoming)) {
      const keyName = isPermission(incoming)
        ? incoming.key
        : isPermission(existing)
          ? existing.key
          : key;
      throw new Error(`PermDock: duplicate permission key '${keyName}'`);
    }
    // SAFETY: a leaf on either side threw above, so existing is a group.
    const nested: Record<string, PermissionTree | Permission> = {
      ...(existing as PermissionTree),
    };
    mergeNodes(nested, incoming, keys, registry, sourceRegistry);
    target[key] = freezeDeep(nested);
  }
  if (sourceRegistry !== undefined) {
    for (const [name, node] of sourceRegistry) {
      if (registry.has(name) && registry.get(name) !== node) {
        throw new Error(`PermDock: duplicate resource name '${name}'`);
      }
      registry.set(name, node);
    }
  }
}

export function mergePermissions<const Trees extends readonly PermissionTree[]>(
  ...trees: Trees
): PermissionTree {
  if (trees.length === 0) {
    throw new Error("PermDock: mergePermissions() requires at least one tree");
  }
  const merged: Record<string, PermissionTree | Permission> = {};
  const keys = new Set<string>();
  const registry = new Map<string, ResourceNode>();
  for (const tree of trees) {
    const sourceRegistry = isRegistryTree(tree)
      ? tree[TREE_REGISTRY]
      : undefined;
    mergeNodes(merged, tree, keys, registry, sourceRegistry);
  }
  assertGraphTargets(registry);
  const leaves = collectLeaves(merged);
  assertKeys(leaves);
  return freezeDeep(attachRegistry(merged, registry, leaves));
}

/** Former key to current key, for every leaf of `tree`. */
export function renamedKeys(
  tree: PermissionTree | Permission,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const leaf of listPermissions(tree)) {
    for (const old of formerKeys(leaf)) {
      map.set(old, leaf.key);
    }
  }
  return map;
}
