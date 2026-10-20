import { SQL_IDENT } from "../../core/sql.ts";

export function ident(name: string): string {
  if (!SQL_IDENT.test(name)) {
    throw new TypeError(
      `PermDock CLI: '${name}' is not a plain identifier, which Sync Streams need`,
    );
  }
  return name;
}

function parts(table: string): readonly [string | undefined, string] {
  const dot = table.lastIndexOf(".");
  const schema = dot === -1 ? undefined : ident(table.slice(0, dot));
  const name = ident(table.slice(dot + 1));
  return [schema === "public" ? undefined : schema, name];
}

/** The tables a plan references, by `schema.table`, and the device names of those another table shares a name with. */
export type TableNames = {
  readonly renamed: ReadonlyMap<string, string>;
  readonly seen: Set<string>;
};

type Named = { readonly names?: TableNames };

/**
 * The name a stream query and the device use for the table: its own name,
 * or `<schema>_<table>` for a table outside `public` that shares its name
 * with another synced table, since PowerSync drops the schema on the device.
 */
export function bare(table: string, named: Named): string {
  const [schema, name] = parts(table);
  const key = `${schema ?? "public"}.${name}`;
  named.names?.seen.add(key);
  return named.names?.renamed.get(key) ?? name;
}

/** The table as a stream query reads it: Sync Streams need a schema other than `public` in double quotes. */
export function quotedTable(table: string): string {
  const [schema, name] = parts(table);
  return schema === undefined ? name : `"${schema}"."${name}"`;
}

/** The table in a `FROM` or `JOIN`, aliased to its `bare` name outside `public`. */
export function fromTable(table: string, named: Named): string {
  const [schema] = parts(table);
  return schema === undefined
    ? bare(table, named)
    : `${quotedTable(table)} AS ${bare(table, named)}`;
}

/** `<schema>_<table>` for each table outside `public` whose name another referenced table shares. */
export function renames(seen: Iterable<string>): ReadonlyMap<string, string> {
  const byName = new Map<string, string[]>();
  for (const table of seen) {
    const name = table.slice(table.indexOf(".") + 1);
    byName.set(name, [...(byName.get(name) ?? []), table]);
  }
  const out = new Map<string, string>();
  for (const tables of byName.values()) {
    if (tables.length < 2) {
      continue;
    }
    for (const table of tables) {
      if (!table.startsWith("public.")) {
        out.set(table, table.replace(".", "_"));
      }
    }
  }
  return out;
}

/** The role label of a custom role's grants in warnings and gaps. */
export const CUSTOM_ROLE = "custom role";
