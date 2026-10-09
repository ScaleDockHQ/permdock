import type { Permission } from "./permissions.ts";

/** The row's `id` as a string, when it is a string or a number. */
export function resourceIdOf(data: unknown): string | undefined {
  if (data === null || typeof data !== "object" || !("id" in data)) {
    return undefined;
  }
  const id = data.id;
  return typeof id === "string" || typeof id === "number"
    ? String(id)
    : undefined;
}

/**
 * The `resource` of a decision event: the permission's resource type and the
 * row's `id`, or `wireId` (the id the request named) when the row has none.
 */
export function resourceRef(
  permission: Permission,
  data: unknown,
  wireId?: unknown,
): { readonly type: string; readonly id?: string } {
  const id =
    resourceIdOf(data) ??
    (typeof wireId === "string" || typeof wireId === "number"
      ? String(wireId)
      : undefined);
  return id === undefined
    ? { type: permission.resource }
    : { type: permission.resource, id };
}
