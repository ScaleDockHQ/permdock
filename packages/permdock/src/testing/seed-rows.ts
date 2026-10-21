import type { RlsQueryFn } from "./rls-parity.ts";

import { quoteSqlIdent, quoteSqlTable } from "../core/sql.ts";

/** Rows per table; tables are inserted in key order, so list parents first. */
export type SeedRows = Readonly<
  Record<string, readonly Readonly<Record<string, unknown>>[]>
>;

/**
 * Inserts `factories.*` rows through the `query` function `testRlsParity`
 * takes, one parameterised `insert` per row with the row's own keys as quoted
 * column names. `undefined` fields are left to the column default. Run it as
 * the table owner, before RLS applies. Resolves to the number of rows
 * inserted.
 */
export async function seedRows(
  query: RlsQueryFn,
  rows: SeedRows,
): Promise<number> {
  let inserted = 0;
  for (const [table, list] of Object.entries(rows)) {
    const target = quoteSqlTable(table);
    for (const row of list) {
      const columns = Object.keys(row).filter((key) => row[key] !== undefined);
      await query(
        columns.length === 0
          ? `insert into ${target} default values`
          : `insert into ${target} (${columns.map((column) => quoteSqlIdent(column)).join(", ")}) values (${columns.map((_, index) => `$${String(index + 1)}`).join(", ")})`,
        columns.map((column) => row[column]),
      );
      inserted += 1;
    }
  }
  return inserted;
}
