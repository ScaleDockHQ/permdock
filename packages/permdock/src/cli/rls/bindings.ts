import { qualifySqlTable } from "../../core/sql.ts";
import { tableFor } from "../sql/compile.ts";

/** A resource and the table its generated policies target. */
export type TableBinding = {
  readonly resource: string;
  /** `schema.table`. */
  readonly table: string;
  /** True when `rls.tables` does not name the resource, so the table is named after it. */
  readonly inferred: boolean;
};

/**
 * The table each resource with row policies binds to. With `helpersOnly`,
 * a resource `rls.tables` does not name has no table and no binding.
 */
export function tableBindings(
  resources: readonly string[],
  tables: Readonly<Record<string, string>> | undefined,
  helpersOnly: boolean,
): readonly TableBinding[] {
  const out: TableBinding[] = [];
  for (const resource of [...new Set(resources)].toSorted()) {
    const named = tables !== undefined && Object.hasOwn(tables, resource);
    if (helpersOnly && !named) {
      continue;
    }
    out.push({
      resource,
      table: qualifySqlTable(tableFor(resource, tables)),
      inferred: !named,
    });
  }
  return out;
}

/** The generate notes for `bindings`: the inferred ones, and where to see them all. */
export function bindingNotes(
  bindings: readonly TableBinding[],
  withDatabase: boolean,
): readonly string[] {
  const inferred = bindings.filter((binding) => binding.inferred);
  if (inferred.length === 0) {
    return [];
  }
  const list = inferred
    .map((binding) => `${binding.resource} -> ${binding.table}`)
    .join(", ");
  return [
    `table bindings (no rls.tables entry, so the table is named after the resource): ${list}${withDatabase ? "" : "; run permdock rls explain, or generate with --db-url-stdin, to check each table exists"}`,
  ];
}

/** The inferred bindings whose table `facts` shows missing. */
export function missingBindings(
  bindings: readonly TableBinding[],
  columns: Readonly<Record<string, readonly string[]>>,
): readonly TableBinding[] {
  return bindings.filter(
    (binding) => binding.inferred && columns[binding.table] === undefined,
  );
}
