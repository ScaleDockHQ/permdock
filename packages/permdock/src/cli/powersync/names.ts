import { SQL_IDENT } from "../../core/sql.ts";

export function ident(name: string): string {
  if (!SQL_IDENT.test(name)) {
    throw new TypeError(
      `PermDock CLI: '${name}' is not a plain identifier, which Sync Streams need`,
    );
  }
  return name;
}

/** The table as a stream query names it: unqualified in `public`, `schema.table` otherwise. */
export function bare(table: string): string {
  const name = table.startsWith("public.")
    ? table.slice("public.".length)
    : table;
  return name.split(".").map(ident).join(".");
}
