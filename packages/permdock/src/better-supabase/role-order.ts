import type { CatalogDocument } from "../catalog/types.ts";

export type RoleOrderOptions = {
  /**
   * Keep only roles declared `on` this scope, such as the scope SSO assigns
   * memberships in.
   */
  readonly scope?: string;
  /**
   * The owner role, left out because better-supabase's `roleOrder` must not
   * list it.
   */
  readonly owner?: string;
};

/**
 * The catalog's role keys highest first, for better-supabase's
 * `blocks.sso.options.roleOrder`: a role that `assigns` another comes before
 * it, and roles the `assigns` lists do not order keep catalog order. Roles that
 * assign each other stay together in catalog order, at the first one's place.
 */
export function roleOrderFromCatalog(
  catalog: CatalogDocument,
  options: RoleOrderOptions = {},
): readonly string[] {
  const roles = (catalog.roles ?? []).filter(
    (role) =>
      role.key !== options.owner &&
      (options.scope === undefined || role.on === options.scope),
  );
  const keys = roles.map((role) => role.key);
  const assigns = new Map<string, readonly string[]>(
    roles.map((role) => [
      role.key,
      (role.assigns ?? []).filter(
        (target) => target !== role.key && keys.includes(target),
      ),
    ]),
  );
  const reach = new Map(keys.map((key) => [key, reachable(key, assigns)]));
  // A cycle of roles that assign each other is one group, placed by its first role.
  const group = new Map(
    keys.map((key) => [
      key,
      keys.find(
        (other) =>
          other === key ||
          (reach.get(key)?.has(other) === true &&
            reach.get(other)?.has(key) === true),
      ) ?? key,
    ]),
  );
  const remaining = new Set(keys);
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].find((key) => {
      const own = group.get(key);
      return [...remaining].every(
        (by) =>
          group.get(by) === own ||
          ![...remaining].some(
            (target) =>
              group.get(target) === own &&
              (assigns.get(by) ?? []).includes(target),
          ),
      );
    });
    const own = group.get(ready ?? [...remaining][0] ?? "");
    for (const key of keys) {
      if (remaining.has(key) && group.get(key) === own) {
        order.push(key);
        remaining.delete(key);
      }
    }
  }
  return Object.freeze(order);
}

function reachable(
  from: string,
  assigns: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const seen = new Set<string>();
  const stack = [...(assigns.get(from) ?? [])];
  while (stack.length > 0) {
    const key = stack.pop();
    if (key !== undefined && !seen.has(key)) {
      seen.add(key);
      stack.push(...(assigns.get(key) ?? []));
    }
  }
  return seen;
}
