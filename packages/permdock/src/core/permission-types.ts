import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { AppData, AppDataSchema, WithX } from "./app-data.ts";
import type {
  RESOURCE_BRAND,
  RESOURCE_X,
  TREE_LEAVES,
  TREE_REGISTRY,
} from "./brands.ts";

/** `definePermissions` options. */
export type PermissionsOptions<PX = never, RX = never> = {
  /**
   * Keys a permission used to have, mapped to its current key. Old keys are
   * accepted wherever a key arrives as a string (stored custom roles, OAuth
   * scopes, AuthZEN actions, hosted grants, `findPermission`) and resolve to
   * the current leaf; code, decisions and audit only ever see the current key.
   */
  readonly renamed?: Readonly<Record<string, string>>;
  /**
   * Standard Schemas for app data. `permission` checks every action's `meta.x`
   * and types it on the leaves; `resource` checks every resource's `meta.x` and
   * types it on `getResource`. Both validate synchronously at definition time
   * and throw on invalid data.
   */
  readonly x?: {
    readonly permission?: AppDataSchema<PX>;
    readonly resource?: AppDataSchema<RX>;
  };
};

/**
 * A resource's metadata. PermDock carries it to the catalog and never reads
 * `x`.
 */
export type ResourceMeta<X = AppData> = {
  readonly title?: string;
  readonly description?: string;
  /**
   * Data the application owns. Plain JSON, typed by `definePermissions(…, { x:
   * { resource } })`.
   */
  readonly x?: X;
};

/**
 * A tree whose resources carry `meta.x` of type `X`, read through
 * `getResource`.
 */
export type ResourceXTree<X> = { readonly [RESOURCE_X]?: X };

export type ActionMeta = {
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly readOnly?: boolean;
  /**
   * The action may destroy or overwrite data; only meaningful when not
   * `readOnly`.
   */
  readonly destructive?: boolean;
  /** Repeating the action with the same input has no further effect. */
  readonly idempotent?: boolean;
  /**
   * On a role, or on a permission the subject is granted: whoever holds it may
   * assign the whole custom-role ceiling, not only what they hold themselves.
   */
  readonly manageRoles?: boolean;
  /**
   * Set by a generator (`permdock openapi import`) to the operation an action
   * was inferred from.
   */
  readonly inferredFrom?: string;
  /**
   * Data the application owns, such as a risk level or an undo window. Plain
   * JSON; PermDock carries it on the leaf, the catalog and snapshots and never
   * reads it. `definePermissions(…, { x: { permission } })` types it.
   */
  readonly x?: AppData;
};

export type PermissionKind = "instance" | "collection";

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
export type RelationIncludes = { readonly includes?: readonly string[] };

/** The row's `field` holds the principal id (or, with `memberOf`, a scope id). */
export type FieldRelation = RelationIncludes & {
  readonly field: string;
  /**
   * A declared scope name (or the `tenant` / `team` alias): the field holds
   * that scope's id.
   */
  readonly memberOf?: string;
};

/**
 * Literal values an edge row's columns must hold, so one table backs several
 * relations.
 */
export type EdgeMatch = Readonly<Record<string, string | number | boolean>>;

/**
 * One group resource of an edge: the relation whoever the row names must hold
 * on the group, and, when the group's id has its own typed column, that column
 * in place of the edge's `subject`.
 */
export type EdgeGroup =
  | string
  | { readonly relation: string; readonly subject?: string };

/**
 * Edge rows that name a group instead of a principal: `column` holds the
 * resource name, `subject` the group's id, and the row holds for whoever holds
 * `resources[<name>]` on that group. A null `column` (or `direct`) names a
 * principal; any other value matches nothing. A group with its own `subject`
 * column reads the group's id from it; without `column`, a row names that group
 * when the column is not null, and a principal when the edge's `subject` is not
 * null.
 */
export type EdgeGroups = {
  /** Required unless every group names its own `subject` column. */
  readonly column?: string;
  readonly resources: Readonly<Record<string, EdgeGroup>>;
  /** The `column` value of a row naming a principal, besides `null`. */
  readonly direct?: string;
};

/** One group resource of an edge, normalised. */
export type EdgeGroupEntry = {
  readonly resource: string;
  readonly relation: string;
  /**
   * The column holding the group's id: the group's own, else the edge's
   * `subject`.
   */
  readonly subject: string;
  /**
   * Whether the group reads its own typed column rather than the edge's
   * `subject`.
   */
  readonly typed: boolean;
};

/**
 * One row per holder in an edge table: `object` holds the resource id,
 * `subject` the principal id.
 */
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

/**
 * On a principal resource: the row's `principal` column holds the principal who
 * holds the relation over it.
 */
export type PrincipalRelation = RelationIncludes & {
  readonly principal: string;
  /**
   * Timestamp columns bounding when the relation holds; `null` leaves that side
   * open.
   */
  readonly period?: { readonly startsAt?: string; readonly expiresAt?: string };
};

/** Held only through the relations it includes. */
export type ComputedRelation = { readonly includes: readonly string[] };

export type ResourceRelation =
  | FieldRelation
  | EdgeRelation
  | PrincipalRelation
  | ComputedRelation;

export type ResourceRelationInput = string | ResourceRelation;

/**
 * A to-one link from a row to another resource's instance, walked by `through:
 * [<link>]`.
 */
export type ResourceLink = {
  readonly field: string;
  readonly resource: string;
};

export type ResourceRestricted = {
  readonly field: string;
  readonly stops?: readonly string[];
};

export type ActionList = readonly string[] | Record<string, ActionMeta>;

export type ResourceOptions<
  A extends ActionList | undefined = ActionList | undefined,
  C extends ActionList | undefined = ActionList | undefined,
> = {
  /**
   * The resource name leaves, tables, relations and AuthZEN types use; the last
   * path segment when absent. Names are unique across a tree.
   */
  readonly name?: string;
  readonly id?: string;
  readonly actions?: A;
  readonly collection?: C;
  readonly parent?: ResourceParent;
  readonly links?: Readonly<Record<string, ResourceLink>>;
  readonly relations?: Readonly<Record<string, ResourceRelationInput>>;
  /**
   * The row field that changes whenever the row does (`updatedAt`, a revision
   * counter). An `approval: { staleOn: 'resource-change' }` binds to its
   * value.
   */
  readonly version?: string;
  /**
   * A boolean column: a row where it is `true` is reached only by grants on
   * itself, never by relations held on its ancestors.
   */
  readonly restricted?: string | ResourceRestricted;
  /**
   * `'hide'`: a denied check on a loaded row answers as if the row did not
   * exist (HTTP `404`), so an id never confirms a row the caller cannot read.
   */
  readonly disclosure?: "hide" | "reveal";
  /**
   * Named grant levels a custom role may pick per permission, each a row
   * condition (`where` shorthand or a `Condition`), such as `own`, `team` and
   * `all`. A level narrows the ceiling grant it applies to and never widens it;
   * it reaches only instance actions. Names match `^[a-z][a-z0-9_]*$`.
   */
  readonly levels?: Readonly<Record<string, ResourceLevel>>;
  /**
   * `true`: `levels` run from narrowest to widest in declaration order, and a
   * holder of a level may hand out every level declared before it. Evaluation
   * is unchanged: each level still applies only its own condition.
   */
  readonly orderedLevels?: true;
  /**
   * Display text and app data for the resource; carried to the catalog, never
   * read in evaluation.
   */
  readonly meta?: ResourceMeta;
};

/**
 * A level's row condition: `where` shorthand or a normalised `Condition`,
 * checked by `definePolicy`.
 */
export type ResourceLevel = Readonly<Record<string, unknown>>;

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
  readonly restrictedStops?: readonly string[];
  readonly disclosure: "hide" | "reveal";
  readonly instanceActions: ReadonlySet<string>;
  readonly collectionActions: ReadonlySet<string>;
  /**
   * Declared level names to their raw condition; `definePolicy` normalises
   * them.
   */
  readonly levels?: Readonly<Record<string, ResourceLevel>>;
  /** Set when the resource declares `orderedLevels: true`. */
  readonly orderedLevels?: true;
  /** The resource's `meta`, when it declares one. */
  readonly meta?: ResourceMeta;
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
  X = never,
> = [Names] extends [never]
  ? object
  : {
      readonly [K in Names]: WithX<
        Permission<Prefix extends "" ? K : `${Prefix}.${K}`, T, Kind>,
        X
      >;
    };

export type InferResourceLeaves<
  R extends ResourceInit,
  Prefix extends string,
  X = never,
> =
  R extends ResourceInit<infer T, infer A, infer C>
    ? LeavesFrom<Prefix, ActionNames<A>, T, "instance", X> &
        LeavesFrom<Prefix, ActionNames<C>, T, "collection", X>
    : object;

export type InferPermissionTree<
  Input,
  Prefix extends string = "",
  X = never,
> = Input extends ResourceInit
  ? InferResourceLeaves<Input, Prefix, X>
  : Input extends Record<string, unknown>
    ? {
        readonly [K in keyof Input & string]: InferPermissionTree<
          Input[K],
          Prefix extends "" ? K : `${Prefix}.${K}`,
          X
        >;
      }
    : never;

/**
 * The tree `definePermissions(input, options)` returns, nameable for an
 * explicit annotation under `isolatedDeclarations`.
 */
export type PermissionsOf<Input, PX = never, RX = never> = InferPermissionTree<
  Input,
  "",
  PX
> &
  ResourceXTree<RX>;

export type ToolHints = {
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
};
