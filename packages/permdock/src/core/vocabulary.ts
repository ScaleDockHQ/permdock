import type { ActionMeta } from './permissions.ts';

import { freezeDeep } from './freeze.ts';
import { assertSafeKey, isForbiddenKey, ownKeys } from './paths.ts';

export const ROLE_KIND = 'role' as const;
export const PLAN_KIND = 'plan' as const;

export type Role<K extends string = string> = {
  readonly key: K;
  readonly on?: 'tenant' | 'team';
  readonly assignable: boolean;
  readonly meta: ActionMeta;
  readonly kind: typeof ROLE_KIND;
};

export type Plan<K extends string = string> = {
  readonly key: K;
  readonly meta: ActionMeta;
  readonly kind: typeof PLAN_KIND;
};

export type RoleInit = {
  readonly on?: 'tenant' | 'team';
  readonly assignable?: boolean;
  readonly meta?: ActionMeta;
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
  assertSafeKey(key, 'role');
  const on = init.on;
  const assignable = init.assignable ?? on !== undefined;
  const leaf = {
    key,
    assignable,
    meta: freezeDeep({ ...init.meta }),
  } as Role<K>;
  if (on !== undefined) {
    Object.assign(leaf, { on });
  }
  Object.defineProperty(leaf, 'kind', {
    value: ROLE_KIND,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(leaf);
}

function makePlan<K extends string>(key: K, init: PlanInit): Plan<K> {
  assertSafeKey(key, 'plan');
  const leaf = {
    key,
    meta: freezeDeep({ ...init.meta }),
  } as Plan<K>;
  Object.defineProperty(leaf, 'kind', {
    value: PLAN_KIND,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(leaf);
}

export function isRole(value: unknown): value is Role {
  return (
    value !== null &&
    typeof value === 'object' &&
    'key' in value &&
    typeof (value as Role).key === 'string' &&
    (value as Role).kind === ROLE_KIND
  );
}

export function isPlan(value: unknown): value is Plan {
  return (
    value !== null &&
    typeof value === 'object' &&
    'key' in value &&
    typeof (value as Plan).key === 'string' &&
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
  options?: { readonly on?: 'tenant' | 'team'; readonly assignable?: boolean },
): Role {
  const on = options?.on;
  if (on === undefined) {
    return makeRole(key, { assignable: options?.assignable ?? false });
  }
  return makeRole(key, { on, assignable: options?.assignable ?? false });
}
