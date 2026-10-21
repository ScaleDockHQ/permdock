export const RESOURCE_BRAND: unique symbol = Symbol.for("permdock.resource");

export const TREE_REGISTRY: unique symbol = Symbol.for("permdock.registry");

export const NODE_RESOURCE: unique symbol = Symbol.for("permdock.resource");

export const TREE_LEAVES: unique symbol = Symbol.for("permdock.leaves");

export const LEAF_FORMER: unique symbol = Symbol.for("permdock.former");

/**
 * Phantom key carrying a tree's resource `x` type for `getResource`. Exported
 * as a type only, so a consumer's declaration emit can name it; it has no
 * value.
 */
export declare const RESOURCE_X: unique symbol;

/**
 * Phantom key carrying the literal `name` a `resource(…, { name })` was given,
 * so its leaves type `resource` by that name rather than the path segment. Type
 * only; it has no value.
 */
export declare const RESOURCE_NAME: unique symbol;

/**
 * Phantom key carrying a policy's `scopes` input type for `ScopeNameOf`. Type
 * only; it has no value.
 */
export declare const POLICY_SCOPES: unique symbol;
