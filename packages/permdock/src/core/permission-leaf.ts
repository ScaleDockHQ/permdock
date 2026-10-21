import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { AppDataSchema } from "./app-data.ts";
import type {
  ActionList,
  ActionMeta,
  Permission,
  PermissionKind,
  ResourceInit,
  ResourceMeta,
  ResourceOptions,
  ToolHints,
} from "./permission-types.ts";

import { assertAppData, parseAppData } from "./app-data.ts";
import { LEAF_FORMER, RESOURCE_BRAND } from "./brands.ts";
import { compact, isReadonlyArray } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  // SAFETY: '~standard' is checked to be a key; the optional chain reads version defensively.
  return (
    value !== null &&
    typeof value === "object" &&
    "~standard" in value &&
    typeof (value as { readonly "~standard"?: { readonly version?: unknown } })[
      "~standard"
    ]?.version === "number"
  );
}

export function isResourceInit(value: unknown): value is ResourceInit {
  return (
    value !== null &&
    typeof value === "object" &&
    RESOURCE_BRAND in value &&
    value[RESOURCE_BRAND] === true
  );
}

function isResourceOptions(value: unknown): value is ResourceOptions {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isStandardSchema(value)
  );
}

export function metaFor(
  list: ActionList | undefined,
  action: string,
  schema: AppDataSchema<unknown> | undefined,
): ActionMeta {
  if (list === undefined || Array.isArray(list)) {
    return freezeDeep({});
  }
  // SAFETY: Array.isArray does not narrow a readonly array; the non-array ActionList is this map.
  const meta = (list as Record<string, ActionMeta>)[action];
  if (meta?.x === undefined) {
    return freezeDeep({ ...meta });
  }
  return freezeDeep({
    ...meta,
    x: parseAppData(schema, meta.x, `meta.x of action '${action}'`),
  });
}

export function resourceMetaFor(
  name: string,
  meta: ResourceMeta | undefined,
  schema: AppDataSchema<unknown> | undefined,
): ResourceMeta | undefined {
  if (meta === undefined) {
    return undefined;
  }
  assertAppData(meta, `meta of resource '${name}'`);
  for (const field of ["title", "description"] as const) {
    if (meta[field] !== undefined && typeof meta[field] !== "string") {
      throw new TypeError(
        `PermDock: meta.${field} of resource '${name}' must be a string`,
      );
    }
  }
  return freezeDeep(
    compact<ResourceMeta>({
      title: meta.title,
      description: meta.description,
      x:
        meta.x === undefined
          ? undefined
          : parseAppData(schema, meta.x, `meta.x of resource '${name}'`),
    }),
  );
}

/**
 * MCP and WebMCP tool hints from a permission's `meta`. Hints only inform the
 * client; every call is still decided on the server.
 */
export function annotationsFor(permission: Permission): ToolHints {
  const { meta } = permission;
  const readOnlyHint =
    meta.readOnly ??
    (permission.action === "read" || permission.action === "list");
  return compact<ToolHints>({
    readOnlyHint,
    destructiveHint: readOnlyHint ? undefined : meta.destructive,
    idempotentHint: meta.idempotent,
  });
}

export function actionNames(list: ActionList | undefined): readonly string[] {
  if (list === undefined) {
    return [];
  }
  if (isReadonlyArray(list)) {
    return list;
  }
  return Object.keys(list);
}

export function keyToScope(key: string): string {
  return key.replaceAll(".", ":");
}

export function makeLeaf<K extends string, T, Kind extends PermissionKind>(
  key: K,
  resourceName: string,
  action: string,
  meta: ActionMeta,
  kind: Kind,
  former: readonly string[] | undefined,
): Permission<K, T, Kind> {
  // SAFETY: T is a phantom type parameter; kind is defined on the leaf right below.
  const leaf = {
    key,
    scope: keyToScope(key),
    resource: resourceName,
    action,
    meta,
  } as Permission<K, T, Kind>;
  Object.defineProperty(leaf, "kind", {
    value: kind,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  if (former !== undefined && former.length > 0) {
    Object.defineProperty(leaf, LEAF_FORMER, {
      value: Object.freeze([...former].toSorted()),
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(leaf);
}

/**
 * The keys `permission` was renamed from, sorted. Empty for a leaf without
 * renames and for one that crossed a serialisation boundary.
 */
export function formerKeys(permission: object): readonly string[] {
  if (!Object.hasOwn(permission, LEAF_FORMER)) {
    return [];
  }
  const value: unknown = Reflect.get(permission, LEAF_FORMER);
  return isReadonlyArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The OAuth scope strings `permission` used to have: each former key with `.`
 * as `:`.
 */
export function formerScopes(permission: object): readonly string[] {
  return formerKeys(permission).map(keyToScope);
}

export function resource<
  T,
  const A extends ActionList = readonly [],
  const C extends ActionList = readonly [],
  const N extends string = never,
>(
  schema: StandardSchemaV1<unknown, T>,
  options?: ResourceOptions<A, C> & { readonly name?: N },
): ResourceInit<T, A, C, N>;

export function resource<
  const A extends ActionList = readonly [],
  const C extends ActionList = readonly [],
  const N extends string = never,
>(
  options: ResourceOptions<A, C> & { readonly name?: N },
): ResourceInit<unknown, A, C, N>;

export function resource(
  schemaOrOptions?: StandardSchemaV1 | ResourceOptions,
  options?: ResourceOptions,
): ResourceInit {
  if (schemaOrOptions === undefined && options === undefined) {
    throw new Error("PermDock: resource() requires a schema or options");
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
    "PermDock: resource() first argument must be a schema or options",
  );
}
