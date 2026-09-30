import type { StandardSchemaV1 } from '@standard-schema/spec';

import { compact, isReadonlyArray } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import {
  assertSafeKey,
  isForbiddenKey,
  MAX_GROUP_DEPTH,
  ownKeys,
} from './paths.ts';

const RESOURCE_BRAND: unique symbol = Symbol.for('permdock.resource');
const TREE_REGISTRY: unique symbol = Symbol.for('permdock.registry');
const TREE_LEAVES: unique symbol = Symbol.for('permdock.leaves');

export type ActionMeta = {
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly readOnly?: boolean;
  /** The action may destroy or overwrite data; only meaningful when not `readOnly`. */
  readonly destructive?: boolean;
  /** Repeating the action with the same input has no further effect. */
  readonly idempotent?: boolean;
  /**
   * On a role, or on a permission the subject is granted: whoever holds it may
   * assign the whole custom-role ceiling, not only what they hold themselves.
   */
  readonly manageRoles?: boolean;
  /** Set by a generator (`permdock openapi import`) to the operation an action was inferred from. */
  readonly inferredFrom?: string;
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

/** Relations on the same resource whose holders also hold this one. */
export type RelationIncludes = {
  readonly includes?: readonly string[];
};

/** The row's `field` holds the principal id (or, with `memberOf`, a scope id). */
export type FieldRelation = RelationIncludes & {
  readonly field: string;
  /** A declared scope name (or the `tenant` / `team` alias): the field holds that scope's id. */
  readonly memberOf?: string;
};

/** Literal values an edge row's columns must hold, so one table backs several relations. */
export type EdgeMatch = Readonly<Record<string, string | number | boolean>>;

/**
 * Edge rows that name a group instead of a principal: `column` holds the
 * resource name, `subject` the group's id, and the row holds for whoever
 * holds `resources[<name>]` on that group. A null `column` (or `direct`)
 * names a principal; any other value matches nothing.
 */
export type EdgeGroups = {
  readonly column: string;
  readonly resources: Readonly<Record<string, string>>;
  /** The `column` value of a row naming a principal, besides `null`. */
  readonly direct?: string;
};

/** One row per holder in an edge table: `object` holds the resource id, `subject` the principal id. */
export type EdgeRelation = RelationIncludes & {
  readonly edge: string;
  /** Default `<resource>_id`. */
  readonly object?: string;
  /** Default `user_id`. */
  readonly subject?: string;
  /** A timestamp column; an edge whose value has passed does not match. */
  readonly expiresAt?: string;
  readonly match?: EdgeMatch;
  readonly groups?: EdgeGroups;
};

/** On a principal resource: the row's `principal` column holds the principal who holds the relation over it. */
export type PrincipalRelation = RelationIncludes & {
  readonly principal: string;
  /** Timestamp columns bounding when the relation holds; `null` leaves that side open. */
  readonly period?: {
    readonly startsAt?: string;
    readonly expiresAt?: string;
  };
};

/** Held only through the relations it includes. */
export type ComputedRelation = {
  readonly includes: readonly string[];
};

export type ResourceRelation =
  | FieldRelation
  | EdgeRelation
  | PrincipalRelation
  | ComputedRelation;

export type ResourceRelationInput = string | ResourceRelation;

/** A to-one link from a row to another resource's instance, walked by `through: [<link>]`. */
export type ResourceLink = {
  readonly field: string;
  readonly resource: string;
};

export function isFieldRelation(
  relation: ResourceRelation | undefined,
): relation is FieldRelation {
  return relation !== undefined && 'field' in relation;
}

export function isEdgeRelation(
  relation: ResourceRelation | undefined,
): relation is EdgeRelation {
  return relation !== undefined && 'edge' in relation;
}

export function isPrincipalRelation(
  relation: ResourceRelation | undefined,
): relation is PrincipalRelation {
  return relation !== undefined && 'principal' in relation;
}

export function isComputedRelation(
  relation: ResourceRelation | undefined,
): relation is ComputedRelation {
  return (
    relation !== undefined &&
    !('field' in relation) &&
    !('edge' in relation) &&
    !('principal' in relation)
  );
}

/**
 * The relations whose holders hold `name` on `node`: `name` itself when it
 * has a source, then everything it includes, transitively, each once.
 * `definePermissions` rejects cycles and unknown names, so this terminates.
 */
export function expandRelation(
  node: ResourceNode | undefined,
  name: string,
): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (current: string): void => {
    if (seen.has(current)) {
      return;
    }
    seen.add(current);
    const spec = node?.relations[current];
    if (spec === undefined) {
      return;
    }
    if (!isComputedRelation(spec)) {
      out.push(current);
    }
    for (const included of spec.includes ?? []) {
      visit(included);
    }
  };
  visit(name);
  return out;
}

/** Whether `node` names itself as its parent (nested folders, sub-teams, reporting lines). */
export function isSelfParented(node: ResourceNode | undefined): boolean {
  return node?.parent !== undefined && node.parent.resource === node.name;
}

export type ActionList = readonly string[] | Record<string, ActionMeta>;

export type ResourceOptions<
  A extends ActionList | undefined = ActionList | undefined,
  C extends ActionList | undefined = ActionList | undefined,
> = {
  readonly id?: string;
  readonly actions?: A;
  readonly collection?: C;
  readonly parent?: ResourceParent;
  readonly links?: Readonly<Record<string, ResourceLink>>;
  readonly relations?: Readonly<Record<string, ResourceRelationInput>>;
  /**
   * The row field that changes whenever the row does (`updatedAt`, a revision
   * counter). An `approval: { staleOn: 'resource-change' }` binds to its value.
   */
  readonly version?: string;
  /**
   * A boolean column: a row where it is `true` is reached only by grants on
   * itself, never by relations held on its ancestors.
   */
  readonly restricted?: string;
  /**
   * `'hide'`: a denied check on a loaded row answers as if the row did not
   * exist (HTTP `404`), so an id never confirms a row the caller cannot read.
   */
  readonly disclosure?: 'hide' | 'reveal';
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
  readonly links: Readonly<Record<string, ResourceLink>>;
  readonly relations: Readonly<Record<string, ResourceRelation>>;
  readonly version: string | undefined;
  readonly restricted: string | undefined;
  readonly disclosure: 'hide' | 'reveal';
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

export type ToolHints = {
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
};

/**
 * MCP and WebMCP tool hints from a permission's `meta`. Hints only inform the
 * client; every call is still decided on the server.
 */
export function annotationsFor(permission: Permission): ToolHints {
  const { meta } = permission;
  const readOnlyHint =
    meta.readOnly ??
    (permission.action === 'read' || permission.action === 'list');
  return compact<ToolHints>({
    readOnlyHint,
    destructiveHint: readOnlyHint ? undefined : meta.destructive,
    idempotentHint: meta.idempotent,
  });
}

function actionNames(list: ActionList | undefined): readonly string[] {
  if (list === undefined) {
    return [];
  }
  if (isReadonlyArray(list)) {
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

const EDGE_TABLE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/u;

function normaliseRelation(
  resourceName: string,
  relationName: string,
  spec: ResourceRelationInput,
): ResourceRelation {
  if (typeof spec === 'string') {
    assertSafeKey(spec, 'relation field');
    return { field: spec };
  }
  const label = `relation '${relationName}' on '${resourceName}'`;
  const includes = normaliseIncludes(label, spec.includes);
  const kinds = ['field', 'edge', 'principal'].filter((kind) => kind in spec);
  if (kinds.length === 0 && includes !== undefined) {
    return { includes };
  }
  if (kinds.length !== 1) {
    throw new Error(
      `PermDock: ${label} needs exactly one of field, edge, principal or includes`,
    );
  }
  const withIncludes = includes === undefined ? {} : { includes };
  if (isEdgeRelation(spec)) {
    if (!EDGE_TABLE.test(spec.edge)) {
      throw new Error(
        `PermDock: ${label} has an unsafe edge table '${spec.edge}'`,
      );
    }
    for (const column of [spec.object, spec.subject, spec.expiresAt]) {
      if (column !== undefined) {
        assertSafeKey(column, 'edge column');
      }
    }
    return {
      edge: spec.edge,
      ...(spec.object === undefined ? {} : { object: spec.object }),
      ...(spec.subject === undefined ? {} : { subject: spec.subject }),
      ...(spec.expiresAt === undefined ? {} : { expiresAt: spec.expiresAt }),
      ...(spec.match === undefined
        ? {}
        : { match: normaliseMatch(label, spec.match) }),
      ...(spec.groups === undefined
        ? {}
        : { groups: normaliseGroups(label, spec.groups) }),
      ...withIncludes,
    };
  }
  if (isPrincipalRelation(spec)) {
    assertSafeKey(spec.principal, 'relation principal');
    for (const column of [spec.period?.startsAt, spec.period?.expiresAt]) {
      if (column !== undefined) {
        assertSafeKey(column, 'relation period');
      }
    }
    return spec.period === undefined
      ? { principal: spec.principal, ...withIncludes }
      : {
          principal: spec.principal,
          period: { ...spec.period },
          ...withIncludes,
        };
  }
  const field = spec as FieldRelation;
  assertSafeKey(field.field, 'relation field');
  if (field.memberOf !== undefined && includes !== undefined) {
    throw new Error(
      `PermDock: ${label} is a memberOf relation and cannot include others`,
    );
  }
  return field.memberOf === undefined
    ? { field: field.field, ...withIncludes }
    : { field: field.field, memberOf: field.memberOf };
}

function normaliseIncludes(
  label: string,
  includes: unknown,
): readonly string[] | undefined {
  if (includes === undefined) {
    return undefined;
  }
  if (!Array.isArray(includes) || includes.length === 0) {
    throw new Error(
      `PermDock: ${label} includes must be a non-empty list of relation names`,
    );
  }
  for (const name of includes as readonly unknown[]) {
    if (typeof name !== 'string') {
      throw new TypeError(`PermDock: ${label} includes a non-string name`);
    }
    assertSafeKey(name, 'included relation');
  }
  return [...new Set(includes as readonly string[])];
}

function normaliseMatch(label: string, match: EdgeMatch): EdgeMatch {
  const out: Record<string, string | number | boolean> = {};
  const columns = Object.keys(match);
  if (columns.length === 0) {
    throw new Error(`PermDock: ${label} match needs at least one column`);
  }
  for (const column of columns) {
    assertSafeKey(column, 'edge match column');
    const value = match[column];
    if (
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new Error(
        `PermDock: ${label} match '${column}' must be a string, a finite number or a boolean`,
      );
    }
    out[column] = value;
  }
  return out;
}

function normaliseGroups(label: string, groups: EdgeGroups): EdgeGroups {
  assertSafeKey(groups.column, 'edge groups column');
  const resources: Record<string, string> = {};
  const names = Object.keys(groups.resources);
  if (names.length === 0) {
    throw new Error(`PermDock: ${label} groups needs at least one resource`);
  }
  for (const name of names) {
    assertSafeKey(name, 'group resource');
    const relationName = groups.resources[name];
    if (typeof relationName !== 'string') {
      throw new TypeError(
        `PermDock: ${label} groups '${name}' must name a relation`,
      );
    }
    assertSafeKey(relationName, 'group relation');
    resources[name] = relationName;
  }
  if (groups.direct !== undefined && groups.direct in resources) {
    throw new Error(
      `PermDock: ${label} groups direct '${groups.direct}' is also a group resource`,
    );
  }
  return groups.direct === undefined
    ? { column: groups.column, resources }
    : { column: groups.column, resources, direct: groups.direct };
}

/** An included relation must exist on the same resource, be tenancy-free and never include itself back. */
function assertIncludes(node: ResourceNode): void {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, path: readonly string[]): void => {
    if (state.get(name) === 'done') {
      return;
    }
    if (state.get(name) === 'visiting') {
      throw new Error(
        `PermDock: relation includes on '${node.name}' form a cycle: ${[...path, name].join(' -> ')}`,
      );
    }
    state.set(name, 'visiting');
    for (const included of node.relations[name]?.includes ?? []) {
      const target = node.relations[included];
      if (target === undefined) {
        throw new Error(
          `PermDock: relation '${name}' on '${node.name}' includes '${included}', which '${node.name}' does not declare`,
        );
      }
      if (isFieldRelation(target) && target.memberOf !== undefined) {
        throw new Error(
          `PermDock: relation '${name}' on '${node.name}' includes the memberOf relation '${included}'; scopes are tenancy, not the object graph`,
        );
      }
      visit(included, [...path, name]);
    }
    state.set(name, 'done');
  };
  for (const name of Object.keys(node.relations)) {
    visit(name, []);
  }
}

function assertGroupTarget(
  registry: ReadonlyMap<string, ResourceNode>,
  node: ResourceNode,
  relationName: string,
  spec: ResourceRelation,
  target: string,
  targetRelation: string,
): void {
  const label = `relation '${relationName}' on '${node.name}' groups '${target}'`;
  const targetSpec = registry.get(target)?.relations[targetRelation];
  if (targetSpec === undefined) {
    throw new Error(
      `PermDock: ${label} names '${target}#${targetRelation}', which is not declared`,
    );
  }
  if (isFieldRelation(targetSpec) && targetSpec.memberOf !== undefined) {
    throw new Error(
      `PermDock: ${label} names a memberOf relation; scopes are tenancy, not the object graph`,
    );
  }
  if (
    target === node.name &&
    (targetRelation !== relationName || spec.includes !== undefined)
  ) {
    throw new Error(
      `PermDock: ${label}: a group on its own resource must name the same relation, which includes nothing`,
    );
  }
}

/**
 * Links and group targets name declared resources and relations. Groups may
 * nest within one resource (teams in teams) through the same relation, which
 * then includes nothing, so SQL can walk it with one bounded recursive query;
 * a group cycle across resources is rejected.
 */
function assertGraphTargets(registry: ReadonlyMap<string, ResourceNode>): void {
  const edges = new Map<string, Set<string>>();
  for (const node of registry.values()) {
    for (const [linkName, link] of Object.entries(node.links)) {
      if (!registry.has(link.resource)) {
        throw new Error(
          `PermDock: link '${linkName}' on '${node.name}' names the undeclared resource '${link.resource}'`,
        );
      }
    }
    for (const [relationName, spec] of Object.entries(node.relations)) {
      if (!isEdgeRelation(spec) || spec.groups === undefined) {
        continue;
      }
      for (const [target, targetRelation] of Object.entries(
        spec.groups.resources,
      )) {
        assertGroupTarget(
          registry,
          node,
          relationName,
          spec,
          target,
          targetRelation,
        );
        if (target !== node.name) {
          const out = edges.get(node.name) ?? new Set<string>();
          out.add(target);
          edges.set(node.name, out);
        }
      }
    }
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string): void => {
    if (state.get(name) === 'done') {
      return;
    }
    if (state.get(name) === 'visiting') {
      throw new Error(
        `PermDock: edge groups form a cycle across resources through '${name}'`,
      );
    }
    state.set(name, 'visiting');
    for (const next of edges.get(name) ?? []) {
      visit(next);
    }
    state.set(name, 'done');
  };
  for (const name of edges.keys()) {
    visit(name);
  }
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
  }
  const version = init.options.version;
  if (version !== undefined) {
    assertSafeKey(version, 'version field');
  }
  const restricted = init.options.restricted;
  if (restricted !== undefined) {
    assertSafeKey(restricted, 'restricted field');
  }
  const disclosure = init.options.disclosure ?? 'reveal';
  if (disclosure !== 'hide' && disclosure !== 'reveal') {
    throw new Error(
      `PermDock: resource "${name}" disclosure must be 'hide' or 'reveal'`,
    );
  }
  const relations: Record<string, ResourceRelation> = {};
  for (const [relationName, spec] of Object.entries(
    init.options.relations ?? {},
  )) {
    assertSafeKey(relationName, 'relation');
    relations[relationName] = freezeDeep(
      normaliseRelation(name, relationName, spec),
    );
  }
  const links: Record<string, ResourceLink> = {};
  for (const [linkName, link] of Object.entries(init.options.links ?? {})) {
    assertSafeKey(linkName, 'link');
    if (linkName === 'parent') {
      throw new Error(
        `PermDock: link 'parent' on '${name}' is reserved; declare it as parent`,
      );
    }
    assertSafeKey(link.field, 'link field');
    assertSafeKey(link.resource, 'link resource');
    links[linkName] = freezeDeep({
      field: link.field,
      resource: link.resource,
    });
  }
  const resourceNode: ResourceNode = Object.freeze({
    name,
    path: prefix,
    schema: init.schema,
    id: init.options.id ?? 'id',
    parent: parent === undefined ? undefined : freezeDeep({ ...parent }),
    links: freezeDeep(links),
    relations: freezeDeep(relations),
    version,
    restricted,
    disclosure,
    instanceActions: instanceSet,
    collectionActions: collectionSet,
  });
  assertIncludes(resourceNode);
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
  assertGraphTargets(registry);
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
  assertGraphTargets(registry);
  const leaves = collectLeaves(merged as PermissionTree);
  return freezeDeep(attachRegistry(merged as PermissionTree, registry, leaves));
}
