import type { RowPair } from "./permdock.ts";
import type { Permission } from "./permissions.ts";

export function isRowPair(value: unknown): value is RowPair<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "current" in value &&
    "next" in value
  );
}

/**
 * The row a `where` reads and the row a `check` reads. An instance check
 * takes a `{ current, next }` pair or one row for both; a collection check
 * has no current row, only the input it creates.
 */
export function rowValues(
  permission: Permission,
  data: unknown,
): { readonly current: unknown; readonly next: unknown } {
  if (permission.kind === "collection") {
    return { current: undefined, next: data };
  }
  if (permission.kind === "instance" && isRowPair(data)) {
    return { current: data.current, next: data.next };
  }
  return { current: data, next: data };
}

/** The row's id under `field` as a string, or `*` when the row has no string or number there. */
export function rowIdOf(row: unknown, field = "id"): string {
  if (row === null || typeof row !== "object" || !Object.hasOwn(row, field)) {
    return "*";
  }
  const id: unknown = Reflect.get(row, field);
  return typeof id === "string" || typeof id === "number" ? String(id) : "*";
}
