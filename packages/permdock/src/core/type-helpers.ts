import type { POLICY_SCOPES } from "./brands.ts";
import type { OperationMap } from "./operations.ts";
import type { Permission } from "./permission-types.ts";
import type { PolicyVocabulary } from "./policy-types.ts";
import type { ScopeNames } from "./scopes.ts";
import type { PlanTree } from "./vocabulary.ts";

/** Recursion guard: a tree nests resources at most this many levels deep. */
type Depth = [never, 0, 1, 2, 3, 4, 5, 6, 7];

/** The literal string keys of `T`, without an index signature. */
type KnownKeys<T> = keyof {
  readonly [
    K in keyof T as string extends K ? never : K extends string ? K : never
  ]: 0;
};

type LeavesOf<T, D extends number> = [D] extends [never]
  ? never
  : T extends Permission
    ? T
    : {
        readonly [K in KnownKeys<T>]-?: LeavesOf<T[K], Depth[D]>;
      }[KnownKeys<T>];

/** The union of the permission leaves of a `definePermissions` tree. */
export type PermissionOf<T> = [KnownKeys<T>] extends [never]
  ? Permission
  : LeavesOf<T, 8>;

type TreeOf<P> = P extends {
  readonly vocabulary: { readonly permissions: infer T };
}
  ? T
  : P;

/** The resource names of a policy or a permission tree, else `string`. */
export type ResourceNameOf<P> = PermissionOf<TreeOf<P>>["resource"];

/** The action names of a policy or a permission tree, else `string`. */
export type ActionNameOf<P> = PermissionOf<TreeOf<P>>["action"];

/** The permission keys of a policy or a permission tree, else `string`. */
export type PermissionKeyOf<P> = PermissionOf<TreeOf<P>>["key"];

/**
 * The scope names a policy's `definePolicy({ scopes })` declares, plus the
 * `tenant` / `team` aliases; `string` for a policy that declares none.
 */
export type ScopeNameOf<P> = P extends { readonly [POLICY_SCOPES]?: infer S }
  ? ScopeNames<Exclude<S, undefined>>
  : string;

/**
 * The plan names a policy declares: the keys of its `definePlans` vocabulary,
 * else `string`.
 */
export type PlanNameOf<P> = P extends { readonly vocabulary: infer V }
  ? V extends { readonly plans: infer T extends PlanTree }
    ? T[keyof T]["key"]
    : string
  : string;

/** The operation names of a `defineOperations` map, else `string`. */
export type OperationNameOf<O> =
  O extends OperationMap<infer D> ? keyof D & string : string;

/**
 * The vocabulary a policy was defined with, for an instance type such as
 * `usePermDock<VocabularyOf<typeof policy>>()`; `PolicyVocabulary` otherwise.
 */
export type VocabularyOf<P> = P extends {
  readonly vocabulary: infer V extends PolicyVocabulary;
}
  ? V
  : PolicyVocabulary;
