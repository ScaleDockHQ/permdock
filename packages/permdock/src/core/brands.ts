export const RESOURCE_BRAND: unique symbol = Symbol.for("permdock.resource");

export const TREE_REGISTRY: unique symbol = Symbol.for("permdock.registry");

export const NODE_RESOURCE: unique symbol = Symbol.for("permdock.resource");

export const TREE_LEAVES: unique symbol = Symbol.for("permdock.leaves");

export const LEAF_FORMER: unique symbol = Symbol.for("permdock.former");

/**
 * Phantom key carrying a tree's resource `x` type for `getResource`. Exported
 * as a type only, so a consumer's declaration emit can name it; it has no value.
 */
export declare const RESOURCE_X: unique symbol;
