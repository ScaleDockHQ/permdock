import type { StandardSchemaV1 } from '@standard-schema/spec';

import { freezeDeep } from './freeze.ts';
import {
  assertSafeKey,
  isForbiddenKey,
  MAX_GROUP_DEPTH,
  ownKeys,
} from './paths.ts';

export const RESOURCE_BRAND: unique symbol = Symbol.for('permdock.resource');
export const TREE_REGISTRY: unique symbol = Symbol.for('permdock.registry');
export const TREE_LEAVES: unique symbol = Symbol.for('permdock.leaves');

export type ActionMeta = {
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly readOnly?: boolean;
};

export type PermissionKind = 'instance' | 'collection';

export type Permission<
  K extends string = string,
  T = unknown,
  Kind extends PermissionKind = PermissionKind,
> = {
  readonly key: K;
  readonly scope: string;
  readonly resource: string;
  readonly action: string;
  readonly meta: ActionMeta;
  readonly kind: Kind;
} & ([T] extends [never] ? unknown : unknown);

export type ResourceParent = {
  readonly field: string;
  readonly resource: string;
};

export type ResourceRelation = {
  readonly field: string;
  readonly memberOf?: 'tenant' | 'team';
};

export type ResourceRelationInput = string | ResourceRelation;

export type ActionList = readonly string[] | Record<string, ActionMeta>;

export type ResourceOptions<
  A extends ActionList | undefined = ActionList | undefined,
  C extends ActionList | undefined = ActionList | undefined,
> = {
  readonly id?: string;
  readonly actions?: A;
  readonly collection?: C;
  readonly parent?: ResourceParent;
  readonly relations?: Readonly<Record<string, ResourceRelationInput>>;
};

export type ResourceInit<
  T = unknown,
  A extends ActionList | undefined = ActionList | undefined,
  C extends ActionList | undefined = ActionList | undefined,
> = {
  readonly [RESOURCE_BRAND]: true;
  readonly schema: StandardSchemaV1<unknown, T> | undefined;
  readonly options: ResourceOptions<A, C>;
};

export type ResourceNode<T = unknown> = {
  readonly name: string;
  readonly path: string;
  readonly schema: StandardSchemaV1<unknown, T> | undefined;
  readonly id: string;
  readonly parent: ResourceParent | undefined;
  readonly relations: Readonly<Record<string, ResourceRelation>>;
  readonly instanceActions: ReadonlySet<string>;
  readonly collectionActions: ReadonlySet<string>;
};

export type PermissionTree = {
  readonly [key: string]: PermissionTree | Permission;
};

export type RegistryTree = PermissionTree & {
  readonly [TREE_REGISTRY]: ReadonlyMap<string, ResourceNode>;
  readonly [TREE_LEAVES]: readonly Permission[];
};

type ActionNames<A extends ActionList | undefined> = A extends readonly string[]
  ? A[number]
  : A extends Record<string, ActionMeta>
    ? keyof A & string
    : never;

type LeavesFrom<
  Prefix extends string,
  Names extends string,
  T,
  Kind extends PermissionKind,
> = [Names] extends [never]
  ? object
  : {
      readonly [K in Names]: Permission<
        Prefix extends '' ? K : `${Prefix}.${K}`,
        T,
        Kind
      >;
    };

export type InferResourceLeaves<R extends ResourceInit, Prefix extends string> =
  R extends ResourceInit<infer T, infer A, infer C>
    ? LeavesFrom<Prefix, ActionNames<A>, T, 'instance'> &
        LeavesFrom<Prefix, ActionNames<C>, T, 'collection'>
    : object;

export type InferPermissionTree<
  Input,
  Prefix extends string = '',
> = Input extends ResourceInit
  ? InferResourceLeaves<Input, Prefix>
  : Input extends Record<string, unknown>
    ? {
        readonly [K in keyof Input & string]: InferPermissionTree<
          Input[K],
          Prefix extends '' ? K : `${Prefix}.${K}`
        >;
      }
    : never;

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    value !== null &&
    typeof value === 'object' &&
    '~standard' in value &&
    typeof (value as { readonly '~standard'?: { readonly version?: unknown } })[
      '~standard'
    ]?.version === 'number'
  );
}

function isResourceInit(value: unknown): value is ResourceInit {
  return (
    value !== null &&
    typeof value === 'object' &&
    RESOURCE_BRAND in value &&
    (value as ResourceInit)[RESOURCE_BRAND] === true
  );
}

function isResourceOptions(value: unknown): value is ResourceOptions {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isStandardSchema(value)
  );
}

function metaFor(list: ActionList | undefined, action: string): ActionMeta {
  if (list === undefined || Array.isArray(list)) {
    return freezeDeep({});
  }
  const meta = (list as Record<string, ActionMeta>)[action];
  return freezeDeep({ ...meta });
}

function actionNames(list: ActionList | undefined): readonly string[] {
  if (list === undefined) {
    return [];
  }
  if (Array.isArray(list)) {
    return list;
  }
  return Object.keys(list);
}

function keyToScope(key: string): string {
  return key.replaceAll('.', ':');
}

function makeLeaf<K extends string, T, Kind extends PermissionKind>(
  key: K,
  resourceName: string,
  action: string,
  meta: ActionMeta,
  kind: Kind,
): Permission<K, T, Kind> {
  const leaf = {
    key,
    scope: keyToScope(key),
    resource: resourceName,
    action,
    meta,
  } as Permission<K, T, Kind>;
  Object.defineProperty(leaf, 'kind', {
    value: kind,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(leaf);
}

export function resource<
  T,
  const A extends ActionList = readonly [],
  const C extends ActionList = readonly [],
>(
  schema: StandardSchemaV1<unknown, T>,
  options?: ResourceOptions<A, C>,
): ResourceInit<T, A, C>;
export function resource<
  const A extends ActionList = readonly [],
  const C extends ActionList = readonly [],
>(options: ResourceOptions<A, C>): ResourceInit<unknown, A, C>;
export function resource(
  schemaOrOptions?: StandardSchemaV1 | ResourceOptions,
  options?: ResourceOptions,
): ResourceInit {
  if (schemaOrOptions === undefined && options === undefined) {
    throw new Error('PermDock: resource() requires a schema or options');
  }
  if (isStandardSchema(schemaOrOptions)) {
    return {
      [RESOURCE_BRAND]: true,
      schema: schemaOrOptions,
      options: options ?? {},
    };
  }
  if (isResourceOptions(schemaOrOptions) && options === undefined) {
    return {
      [RESOURCE_BRAND]: true,
      schema: undefined,
      options: schemaOrOptions,
    };
  }
  throw new Error(
    'PermDock: resource() first argument must be a schema or options',
  );
}

function materialiseResource(
  init: ResourceInit,
  path: readonly string[],
  registry: Map<string, ResourceNode>,
  leaves: Permission[],
  depth: number,
): PermissionTree {
  if (depth > MAX_GROUP_DEPTH) {
    throw new Error(
      `PermDock: permission group nesting exceeds ${MAX_GROUP_DEPTH}`,
    );
  }
  const name = path.at(-1);
  if (name === undefined) {
    throw new Error(
      'PermDock: resource() cannot be the root of definePermissions',
    );
  }
  assertSafeKey(name, 'resource');
  if (registry.has(name)) {
    throw new Error(`PermDock: duplicate resource name '${name}'`);
  }
  const prefix = path.join('.');
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
    assertSafeKey(action, 'action');
    if (instanceSet.has(action)) {
      throw new Error(`PermDock: duplicate action '${action}' on '${name}'`);
    }
    instanceSet.add(action);
    const key = `${prefix}.${action}`;
    const leaf = makeLeaf(
      key,
      name,
      action,
      metaFor(init.options.actions, action),
      'instance',
    );
    node[action] = leaf;
    leaves.push(leaf);
  }
  for (const action of collectionNames) {
    assertSafeKey(action, 'action');
    if (instanceSet.has(action) || collectionSet.has(action)) {
      throw new Error(`PermDock: duplicate action '${action}' on '${name}'`);
    }
    collectionSet.add(action);
    const key = `${prefix}.${action}`;
    const leaf = makeLeaf(
      key,
      name,
      action,
      metaFor(init.options.collection, action),
      'collection',
    );
    node[action] = leaf;
    leaves.push(leaf);
  }
  const parent = init.options.parent;
  if (parent !== undefined) {
    assertSafeKey(parent.field, 'parent field');
    assertSafeKey(parent.resource, 'parent resource');
    if (parent.resource === name) {
      throw new Error(`PermDock: resource '${name}' cannot parent itself`);
    }
  }
  const relations: Record<string, ResourceRelation> = {};
  for (const [relationName, spec] of Object.entries(
    init.options.relations ?? {},
  )) {
    assertSafeKey(relationName, 'relation');
    const normalised: ResourceRelation =
      typeof spec === 'string' ? { field: spec } : { ...spec };
    assertSafeKey(normalised.field, 'relation field');
    relations[relationName] = freezeDeep(normalised);
  }
  const resourceNode: ResourceNode = Object.freeze({
    name,
    path: prefix,
    schema: init.schema,
    id: init.options.id ?? 'id',
    parent: parent === undefined ? undefined : freezeDeep({ ...parent }),
    relations: freezeDeep(relations),
    instanceActions: instanceSet,
    collectionActions: collectionSet,
  });
  registry.set(name, resourceNode);
  return freezeDeep(node);
}

function walk(
  input: unknown,
  path: readonly string[],
  registry: Map<string, ResourceNode>,
  leaves: Permission[],
  depth: number,
): PermissionTree {
  if (depth > MAX_GROUP_DEPTH) {
    throw new Error(
      `PermDock: permission group nesting exceeds ${MAX_GROUP_DEPTH}`,
    );
  }
  if (isResourceInit(input)) {
    return materialiseResource(input, path, registry, leaves, depth);
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      `PermDock: definePermissions expected a group or resource at '${path.join('.')}'`,
    );
  }
  const group: Record<string, PermissionTree | Permission> = {};
  for (const key of Object.keys(input)) {
    assertSafeKey(key, 'group');
    group[key] = walk(
      (input as Record<string, unknown>)[key],
      [...path, key],
      registry,
      leaves,
      depth + 1,
    );
  }
  return group;
}

function attachRegistry(
  tree: PermissionTree,
  registry: ReadonlyMap<string, ResourceNode>,
  leaves: readonly Permission[],
): RegistryTree {
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

export function isRegistryTree(tree: PermissionTree): tree is RegistryTree {
  return TREE_REGISTRY in tree;
}

export function getRegistry(
  tree: PermissionTree,
): ReadonlyMap<string, ResourceNode> {
  if (!isRegistryTree(tree)) {
    throw new Error('PermDock: permission tree is missing its registry');
  }
  return tree[TREE_REGISTRY];
}

export function getResource(
  tree: PermissionTree,
  name: string,
): ResourceNode | undefined {
  if (isForbiddenKey(name)) {
    return undefined;
  }
  return getRegistry(tree).get(name);
}

export function definePermissions<const Input>(
  input: Input,
): InferPermissionTree<Input> {
  const registry = new Map<string, ResourceNode>();
  const leaves: Permission[] = [];
  const tree = walk(input, [], registry, leaves, 0);
  const seen = new Set<string>();
  for (const leaf of leaves) {
    if (seen.has(leaf.key)) {
      /* v8 ignore next */
      throw new Error(`PermDock: duplicate permission key '${leaf.key}'`);
    }
    seen.add(leaf.key);
  }
  return freezeDeep(
    attachRegistry(tree, registry, leaves),
  ) as InferPermissionTree<Input>;
}

function collectLeaves(node: PermissionTree | Permission): Permission[] {
  if ('key' in node && 'scope' in node && 'action' in node) {
    return [node as Permission];
  }
  const out: Permission[] = [];
  for (const key of ownKeys(node)) {
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
  if (isRegistryTree(tree as PermissionTree)) {
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
  for (const leaf of listPermissions(tree)) {
    if (leaf.key === keyOrScope || leaf.scope === keyOrScope) {
      return leaf;
    }
  }
  return undefined;
}

function isPermission(value: unknown): value is Permission {
  return (
    value !== null &&
    typeof value === 'object' &&
    'key' in value &&
    'scope' in value &&
    'resource' in value &&
    'action' in value
  );
}

function mergeNodes(
  target: Record<string, PermissionTree | Permission>,
  source: PermissionTree,
  keys: Set<string>,
  registry: Map<string, ResourceNode>,
  sourceRegistry: ReadonlyMap<string, ResourceNode> | undefined,
): void {
  for (const key of ownKeys(source)) {
    assertSafeKey(key, 'group');
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
    throw new Error('PermDock: mergePermissions() requires at least one tree');
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
  const leaves = collectLeaves(merged as PermissionTree);
  return freezeDeep(attachRegistry(merged as PermissionTree, registry, leaves));
}
