import type { ActionMeta } from "./permissions.ts";

import { freezeDeep } from "./freeze.ts";
import { assertSafeKey, isForbiddenKey, ownKeys } from "./paths.ts";

export const ROLE_KIND = "role" as const;
export const PLAN_KIND = "plan" as const;

/**
 * A role's metadata. `audience` names the surface its holders use (`'staff'`,
 * `'portal'`, `'platform'`); `permdock.audiences()` lists the distinct
 * audiences of the roles held in the active scope.
 */
export type RoleMeta = ActionMeta & {
  readonly audience?: string;
};

export type Role<K extends string = string> = {
  readonly key: K;
  /** A declared scope name, or the `tenant` / `team` alias. */
  readonly on?: string;
  readonly assignable: boolean;
  readonly meta: RoleMeta;
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

export type PlanInit = {
  readonly meta?: ActionMeta;
};

export type RoleTree = {
  readonly [key: string]: Role;
};

export type PlanTree = {
  readonly [key: string]: Plan;
};

export type Vocabulary = {
  readonly permissions?: unknown;
  readonly roles?: RoleTree;
  readonly plans?: PlanTree;
};

type InferRoleTree<Input> = {
  readonly [K in keyof Input & string]: Role<K>;
};

type InferPlanTree<Input> = {
  readonly [K in keyof Input & string]: Plan<K>;
};

function makeRole<K extends string>(key: K, init: RoleInit): Role<K> {
  assertSafeKey(key, "role");
  const on = init.on;
  const assignable = init.assignable ?? on !== undefined;
  // SAFETY: on is assigned when set and kind is defined on the leaf right below.
  const leaf = {
    key,
    assignable,
    meta: freezeDeep({ ...init.meta }),
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

function makePlan<K extends string>(key: K, init: PlanInit): Plan<K> {
  assertSafeKey(key, "plan");
  // SAFETY: kind is defined on the leaf right below.
  const leaf = {
    key,
    meta: freezeDeep({ ...init.meta }),
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

export function defineRoles<const Input extends Record<string, RoleInit>>(
  input: Input,
): InferRoleTree<Input> {
  const tree: Record<string, Role> = {};
  for (const key of Object.keys(input)) {
    if (isForbiddenKey(key)) {
      throw new Error(`PermDock: forbidden role key '${key}'`);
    }
    tree[key] = makeRole(key, input[key] ?? {});
  }
  // SAFETY: tree has one Role per own key of input, keyed by that key, as InferRoleTree maps.
  return freezeDeep(tree) as InferRoleTree<Input>;
}

export function definePlans<const Input extends Record<string, PlanInit>>(
  input: Input,
): InferPlanTree<Input> {
  const tree: Record<string, Plan> = {};
  for (const key of Object.keys(input)) {
    if (isForbiddenKey(key)) {
      throw new Error(`PermDock: forbidden plan key '${key}'`);
    }
    tree[key] = makePlan(key, input[key] ?? {});
  }
  // SAFETY: tree has one Plan per own key of input, keyed by that key, as InferPlanTree maps.
  return freezeDeep(tree) as InferPlanTree<Input>;
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

export function synthesiseRole(
  key: string,
  options?: {
    /** A declared scope name, or the `tenant` / `team` alias. */
    readonly on?: string;
    readonly assignable?: boolean;
    readonly meta?: RoleMeta;
  },
): Role {
  const on = options?.on;
  const assignable = options?.assignable ?? false;
  const meta = options?.meta;
  if (on === undefined) {
    return makeRole(
      key,
      meta === undefined ? { assignable } : { assignable, meta },
    );
  }
  return makeRole(
    key,
    meta === undefined ? { on, assignable } : { on, assignable, meta },
  );
}
