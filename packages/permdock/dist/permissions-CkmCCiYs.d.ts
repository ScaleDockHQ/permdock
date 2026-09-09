import { StandardSchemaV1 } from "@standard-schema/spec";
//#region src/core/permissions.d.ts
declare const RESOURCE_BRAND: unique symbol;
declare const TREE_REGISTRY: unique symbol;
declare const TREE_LEAVES: unique symbol;
type ActionMeta = {
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly readOnly?: boolean;
};
type PermissionKind = "instance" | "collection";
type Permission<K extends string = string, T = unknown, Kind extends PermissionKind = PermissionKind> = {
  readonly key: K;
  readonly scope: string;
  readonly resource: string;
  readonly action: string;
  readonly meta: ActionMeta;
  readonly kind: Kind;
} & ([T] extends [never] ? unknown : unknown);
type ResourceParent = {
  readonly field: string;
  readonly resource: string;
};
type ActionList = readonly string[] | Record<string, ActionMeta>;
type ResourceOptions<A extends ActionList | undefined = ActionList | undefined, C extends ActionList | undefined = ActionList | undefined> = {
  readonly id?: string;
  readonly actions?: A;
  readonly collection?: C;
  readonly parent?: ResourceParent;
};
type ResourceInit<T = unknown, A extends ActionList | undefined = ActionList | undefined, C extends ActionList | undefined = ActionList | undefined> = {
  readonly [RESOURCE_BRAND]: true;
  readonly schema: StandardSchemaV1<unknown, T> | undefined;
  readonly options: ResourceOptions<A, C>;
};
type ResourceNode<T = unknown> = {
  readonly name: string;
  readonly path: string;
  readonly schema: StandardSchemaV1<unknown, T> | undefined;
  readonly id: string;
  readonly parent: ResourceParent | undefined;
  readonly instanceActions: ReadonlySet<string>;
  readonly collectionActions: ReadonlySet<string>;
};
type PermissionTree = {
  readonly [key: string]: PermissionTree | Permission;
};
type RegistryTree = PermissionTree & {
  readonly [TREE_REGISTRY]: ReadonlyMap<string, ResourceNode>;
  readonly [TREE_LEAVES]: readonly Permission[];
};
type ActionNames<A extends ActionList | undefined> = A extends readonly string[] ? A[number] : A extends Record<string, ActionMeta> ? keyof A & string : never;
type LeavesFrom<Prefix extends string, Names extends string, T, Kind extends PermissionKind> = [Names] extends [never] ? object : { readonly [K in Names]: Permission<Prefix extends "" ? K : `${Prefix}.${K}`, T, Kind>; };
type InferResourceLeaves<R extends ResourceInit, Prefix extends string> = R extends ResourceInit<infer T, infer A, infer C> ? LeavesFrom<Prefix, ActionNames<A>, T, "instance"> & LeavesFrom<Prefix, ActionNames<C>, T, "collection"> : object;
type InferPermissionTree<Input, Prefix extends string = ""> = Input extends ResourceInit ? InferResourceLeaves<Input, Prefix> : Input extends Record<string, unknown> ? { readonly [K in keyof Input & string]: InferPermissionTree<Input[K], Prefix extends "" ? K : `${Prefix}.${K}`>; } : never;
declare function resource<T, const A extends ActionList = readonly [], const C extends ActionList = readonly []>(schema: StandardSchemaV1<unknown, T>, options?: ResourceOptions<A, C>): ResourceInit<T, A, C>;
declare function resource<const A extends ActionList = readonly [], const C extends ActionList = readonly []>(options: ResourceOptions<A, C>): ResourceInit<unknown, A, C>;
declare function getResource(tree: PermissionTree, name: string): ResourceNode | undefined;
declare function definePermissions<const Input>(input: Input): InferPermissionTree<Input> & RegistryTree;
declare function listPermissions(tree: PermissionTree | Permission): readonly Permission[];
declare function findPermission(tree: PermissionTree, keyOrScope: string): Permission | undefined;
declare function mergePermissions<const Trees extends readonly PermissionTree[]>(...trees: Trees): PermissionTree & RegistryTree;
//#endregion
export { PermissionTree as a, ResourceOptions as c, findPermission as d, getResource as f, resource as h, PermissionKind as i, ResourceParent as l, mergePermissions as m, ActionMeta as n, ResourceInit as o, listPermissions as p, Permission as r, ResourceNode as s, ActionList as t, definePermissions as u };