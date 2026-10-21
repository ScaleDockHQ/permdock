import type { AppDataSchema, WithX } from "./app-data.ts";
import type { ActionMeta } from "./permission-types.ts";

import { assertAppData, parseAppData, readAppData } from "./app-data.ts";
import { freezeCopy, freezeDeep } from "./freeze.ts";
import { assertSafeKey, isForbiddenKey, ownKeys } from "./paths.ts";

export const ROLE_KIND = "role" as const;
export const PLAN_KIND = "plan" as const;

const TREE_X_SCHEMA: unique symbol = Symbol.for("permdock.x-schema");

/** `defineRoles` and `definePlans` options. */
export type VocabularyOptions<X = never> = {
  /**
   * A Standard Schema for every leaf's `meta.x`, validated synchronously at
   * definition time. On a role tree it also checks the `meta.x` of custom roles
   * a `CustomRoleSource` returns; an invalid one is dropped, not the role.
   */
  readonly x?: AppDataSchema<X>;
};

/**
 * A role's metadata. `audience` names the surface its holders use (`'staff'`,
 * `'portal'`, `'platform'`); `permdock.audiences()` lists the distinct
 * audiences of the roles held in the active scope.
 */
export type RoleMeta = ActionMeta & { readonly audience?: string };

export type Role<K extends string = string> = {
  readonly key: K;
  /** A declared scope name, or the `tenant` / `team` alias. */
  readonly on?: string;
  readonly assignable: boolean;
  readonly meta: RoleMeta;
  /**
   * A shared custom role: the platform defines it for every tenant, and a
   * tenant admin cannot edit it.
   */
  readonly shared?: true;
  readonly kind: typeof ROLE_KIND;
};

export type Plan<K extends string = string> = {
  readonly key: K;
  readonly meta: ActionMeta;
  readonly kind: typeof PLAN_KIND;
};

export type RoleInit = {
  /** A declared scope name, or the `tenant` / `team` alias. */
  readonly on?: string;
  readonly assignable?: boolean;
  readonly meta?: RoleMeta;
};

export type PlanInit = { readonly meta?: ActionMeta };

export type RoleTree = { readonly [key: string]: Role };

export type PlanTree = { readonly [key: string]: Plan };

export type Vocabulary = {
  readonly permissions?: unknown;
  readonly roles?: RoleTree;
  readonly plans?: PlanTree;
};

type InferRoleTree<Input, X = never> = {
  readonly [K in keyof Input & string]: WithX<Role<K>, X>;
};

type InferPlanTree<Input, X = never> = {
  readonly [K in keyof Input & string]: WithX<Plan<K>, X>;
};

function leafMeta(
  kind: string,
  key: string,
  meta: ActionMeta | undefined,
  schema: AppDataSchema<unknown> | undefined,
): ActionMeta {
  if (meta === undefined) {
    return freezeDeep({});
  }
  assertAppData(meta, `meta of ${kind} '${key}'`);
  if (meta.x === undefined) {
    return freezeDeep({ ...meta });
  }
  return freezeDeep({
    ...meta,
    x: parseAppData(schema, meta.x, `meta.x of ${kind} '${key}'`),
  });
}

function makeRole<K extends string>(
  key: K,
  init: RoleInit,
  schema?: AppDataSchema<unknown>,
): Role<K> {
  assertSafeKey(key, "role");
  const on = init.on;
  const assignable = init.assignable ?? on !== undefined;
  // SAFETY: on is assigned when set and kind is defined on the leaf right below.
  const leaf = {
    key,
    assignable,
    meta: leafMeta("role", key, init.meta, schema),
  } as Role<K>;
  if (on !== undefined) {
    Object.assign(leaf, { on });
  }
  Object.defineProperty(leaf, "kind", {
    value: ROLE_KIND,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(leaf);
}

function makePlan<K extends string>(
  key: K,
  init: PlanInit,
  schema?: AppDataSchema<unknown>,
): Plan<K> {
  assertSafeKey(key, "plan");
  // SAFETY: kind is defined on the leaf right below.
  const leaf = {
    key,
    meta: leafMeta("plan", key, init.meta, schema),
  } as Plan<K>;
  Object.defineProperty(leaf, "kind", {
    value: PLAN_KIND,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(leaf);
}

export function isRole(value: unknown): value is Role {
  // SAFETY: value is a non-null object; reading a missing kind gives undefined, never ROLE_KIND.
  return (
    value !== null &&
    typeof value === "object" &&
    "key" in value &&
    typeof value.key === "string" &&
    (value as Role).kind === ROLE_KIND
  );
}

export function isPlan(value: unknown): value is Plan {
  // SAFETY: value is a non-null object; reading a missing kind gives undefined, never PLAN_KIND.
  return (
    value !== null &&
    typeof value === "object" &&
    "key" in value &&
    typeof value.key === "string" &&
    (value as Plan).kind === PLAN_KIND
  );
}

function attachSchema(
  tree: Record<string, unknown>,
  schema: AppDataSchema<unknown> | undefined,
): void {
  if (schema !== undefined) {
    Object.defineProperty(tree, TREE_X_SCHEMA, {
      value: schema,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

/** The `x` schema a `defineRoles` or `definePlans` tree was built with. */
export function treeXSchema(
  tree: object | undefined,
): AppDataSchema<unknown> | undefined {
  if (tree === undefined || !Object.hasOwn(tree, TREE_X_SCHEMA)) {
    return undefined;
  }
  // SAFETY: attachSchema is the only writer of TREE_X_SCHEMA and stores a Standard Schema.
  return Reflect.get(tree, TREE_X_SCHEMA) as AppDataSchema<unknown>;
}

export function defineRoles<
  const Input extends Record<string, RoleInit>,
  X = never,
>(input: Input, options?: VocabularyOptions<X>): InferRoleTree<Input, X> {
  const tree: Record<string, Role> = {};
  for (const key of Object.keys(input)) {
    if (isForbiddenKey(key)) {
      throw new Error(`PermDock: forbidden role key '${key}'`);
    }
    tree[key] = makeRole(key, input[key] ?? {}, options?.x);
  }
  attachSchema(tree, options?.x);
  const built: unknown = freezeDeep(tree);
  // SAFETY: tree has one Role per own key of input, keyed by that key, as InferRoleTree maps; makeRole checked every x against the schema.
  return built as InferRoleTree<Input, X>;
}

export function definePlans<
  const Input extends Record<string, PlanInit>,
  X = never,
>(input: Input, options?: VocabularyOptions<X>): InferPlanTree<Input, X> {
  const tree: Record<string, Plan> = {};
  for (const key of Object.keys(input)) {
    if (isForbiddenKey(key)) {
      throw new Error(`PermDock: forbidden plan key '${key}'`);
    }
    tree[key] = makePlan(key, input[key] ?? {}, options?.x);
  }
  attachSchema(tree, options?.x);
  const built: unknown = freezeDeep(tree);
  // SAFETY: tree has one Plan per own key of input, keyed by that key, as InferPlanTree maps; makePlan checked every x against the schema.
  return built as InferPlanTree<Input, X>;
}

export function listRoles(tree: RoleTree | undefined): readonly Role[] {
  if (tree === undefined) {
    return [];
  }
  return ownKeys(tree).flatMap((key) => {
    const leaf = tree[key];
    return leaf === undefined ? [] : [leaf];
  });
}

export function listPlans(tree: PlanTree | undefined): readonly Plan[] {
  if (tree === undefined) {
    return [];
  }
  return ownKeys(tree).flatMap((key) => {
    const leaf = tree[key];
    return leaf === undefined ? [] : [leaf];
  });
}

export function findRole(
  tree: RoleTree | undefined,
  key: string,
): Role | undefined {
  if (tree === undefined || isForbiddenKey(key)) {
    return undefined;
  }
  return tree[key];
}

/**
 * The meta of a role a source returned (a stored custom role): known string
 * fields kept, `x` checked by the schema. Never throws; anything invalid is
 * left out, and the role itself is never dropped for it.
 */
export function sourceRoleMeta(
  meta: unknown,
  schema: AppDataSchema<unknown> | undefined,
): RoleMeta | undefined {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const text = (field: string): string | undefined => {
    const value: unknown = Object.hasOwn(meta, field)
      ? Reflect.get(meta, field)
      : undefined;
    return typeof value === "string" ? value : undefined;
  };
  const rawX: unknown = Object.hasOwn(meta, "x")
    ? Reflect.get(meta, "x")
    : undefined;
  const out: { -readonly [K in keyof RoleMeta]: RoleMeta[K] } = {};
  for (const field of ["title", "description", "audience"] as const) {
    const value = text(field);
    if (value !== undefined) {
      out[field] = value;
    }
  }
  if (rawX !== undefined) {
    const x = readAppData(schema, rawX);
    if (x !== undefined) {
      out.x = x;
    }
  }
  return Object.keys(out).length === 0 ? undefined : freezeCopy(out);
}

export function synthesiseRole(
  key: string,
  options?: {
    /** A declared scope name, or the `tenant` / `team` alias. */
    readonly on?: string;
    readonly assignable?: boolean;
    readonly meta?: RoleMeta;
    readonly shared?: true;
  },
): Role {
  const on = options?.on;
  const assignable = options?.assignable ?? false;
  const meta = options?.meta;
  const leaf =
    on === undefined
      ? makeRole(
          key,
          meta === undefined ? { assignable } : { assignable, meta },
        )
      : makeRole(
          key,
          meta === undefined ? { on, assignable } : { on, assignable, meta },
        );
  if (options?.shared !== true) {
    return leaf;
  }
  const shared = Object.defineProperty({ ...leaf, shared: true }, "kind", {
    value: ROLE_KIND,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  // SAFETY: a copy of a frozen role leaf with `shared` added and `kind` defined like makeRole defines it.
  return Object.freeze(shared) as Role;
}
