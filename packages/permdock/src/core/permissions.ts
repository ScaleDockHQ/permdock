import type {
  PermissionsOf,
  PermissionsOptions,
  Permission,
  ResourceNode,
} from "./permission-types.ts";

import { freezeDeep } from "./freeze.ts";
import { attachRegistry, walk } from "./materialise-resource.ts";
import { assertKeys, formerByKey } from "./permission-registry.ts";
import { assertGraphTargets } from "./resource-relations.ts";

export type { MetaValue } from "./app-data.ts";

export function definePermissions<const Input, PX = never, RX = never>(
  input: Input,
  options?: PermissionsOptions<PX, RX>,
): PermissionsOf<Input, PX, RX> {
  const registry = new Map<string, ResourceNode>();
  const leaves: Permission[] = [];
  const former = formerByKey(options?.renamed);
  const tree = walk(input, [], registry, leaves, 0, {
    former,
    x: options?.x,
  });
  assertKeys(leaves, former);
  assertGraphTargets(registry);
  const built: unknown = freezeDeep(attachRegistry(tree, registry, leaves));
  // SAFETY: walk builds the tree key by key from input, the shape PermissionsOf maps; metaFor checked every x against the schema; the resource x key is phantom.
  return built as PermissionsOf<Input, PX, RX>;
}
