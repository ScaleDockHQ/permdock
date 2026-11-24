import type { AuthorizationProvider } from "better-supabase/contract";

import type { CatalogDocument } from "../catalog/types.ts";
import type { SupabaseManifest } from "../supabase/manifest.ts";

type Tables = NonNullable<AuthorizationProvider["tables"]>;

/** Actions the generated RLS compiles to a select policy. */
const SELECT_ACTIONS: ReadonlySet<string> = new Set(["read", "list", "get"]);

/**
 * better-supabase's `tables`: for each resource the manifest maps to a table,
 * the permission keys its select policy checks and whether every holder of them
 * in a tenant reads the same rows. A table is `tenant` only when each of those
 * keys is held at the tenant scope alone, carries no row condition and has at
 * least one grant; a table whose rows pass through a restriction, a field mask
 * or a parent table is `row`, and so is one with no select permission.
 *
 * A manifest with `rls.tableReads` answers from it instead, keyed by the
 * qualified table: those entries come from the parsed select policies, which
 * also covers hand-written ones.
 *
 * Doctor BS428 reads the generated select policies and refuses an entry they
 * contradict.
 */
export function tablesOf(
  manifest: SupabaseManifest,
  catalog: CatalogDocument,
  tenantScope: string,
): Tables {
  const reads = manifest.rls.tableReads;
  if (reads !== undefined) {
    return Object.fromEntries(
      reads.map((read) => [
        read.table,
        { share: read.share, permissions: read.permissions ?? [] },
      ]),
    );
  }
  const resources = manifest.names?.resources ?? {};
  const tables: Record<string, Tables[string]> = {};
  for (const [resource, names] of Object.entries(resources)) {
    const { table } = names;
    if (table === undefined) {
      continue;
    }
    const selects = catalog.permissions.filter(
      (permission) =>
        permission.resource === resource &&
        SELECT_ACTIONS.has(permission.action),
    );
    const keys = selects.map((permission) => permission.key).toSorted();
    const shared =
      selects.length > 0 &&
      names.permittedIds === undefined &&
      names.visible === undefined &&
      selects.every((permission) => {
        const grants = (catalog.grants ?? []).filter(
          (grant) => grant.permission === permission.key,
        );
        return (
          permission.rowConditions === false &&
          grants.length > 0 &&
          grants.every((grant) => grant.scope === tenantScope)
        );
      });
    tables[table] = { share: shared ? "tenant" : "row", permissions: keys };
  }
  return tables;
}
