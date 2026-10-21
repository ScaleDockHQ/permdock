/**
 * Runs one parameterised statement: `pg`'s `client.query` (which resolves `{
 * rows }`) and `postgres`'s `sql.unsafe` (which resolves the rows) both fit.
 */
export type SqlQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<
  | readonly Record<string, unknown>[]
  | { readonly rows: readonly Record<string, unknown>[] }
>;

/**
 * The rows of a `SqlQuery` result, whichever of its two shapes the driver
 * resolved.
 */
export function sqlRows(
  result: Awaited<ReturnType<SqlQuery>>,
): readonly Record<string, unknown>[] {
  // SAFETY: SqlQuery's only other variant has rows; Array.isArray does not narrow readonly arrays.
  return Array.isArray(result)
    ? result
    : (result as { readonly rows: readonly Record<string, unknown>[] }).rows;
}

/**
 * A bare Postgres identifier PermDock emits unquoted-safe: letters, digits and
 * `_`, not starting with a digit.
 */
export const SQL_IDENT: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A validated, double-quoted identifier; anything outside `SQL_IDENT` throws. */
export function quoteSqlIdent(name: string, prefix = "PermDock"): string {
  return `"${assertSqlIdent(name, prefix)}"`;
}

/** A schema-qualified name, each part validated by `quoteSqlIdent`. */
export function quoteSqlTable(name: string, prefix = "PermDock"): string {
  return name
    .split(".")
    .map((part) => quoteSqlIdent(part, prefix))
    .join(".");
}

/** A single-quoted string literal with embedded quotes doubled. */
export function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * A double-quoted identifier read back from a database, embedded quotes doubled
 * rather than refused.
 */
export function escapeSqlIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const PLAIN_IDENT = /^[a-z_][a-z0-9_]*$/u;

/**
 * An identifier left bare when it is already lower snake case, otherwise quoted
 * by `escapeSqlIdent`.
 */
export function sqlIdent(name: string): string {
  return PLAIN_IDENT.test(name) ? name : escapeSqlIdent(name);
}

/**
 * The plain-identifier check behind `quoteSqlIdent`, returning the name
 * unquoted.
 */
function assertSqlIdent(name: string, prefix = "PermDock"): string {
  if (!SQL_IDENT.test(name)) {
    throw new TypeError(`${prefix}: unsafe SQL identifier '${name}'`);
  }
  return name;
}

/**
 * `name` with `public.` added when it names no schema; generated functions run
 * with `search_path = ''`.
 */
export function qualifySqlTable(name: string): string {
  return name.includes(".") ? name : `public.${name}`;
}

/** `qualifySqlTable`, then each part quoted by `quoteSqlIdent`. */
export function quoteQualifiedTable(name: string, prefix = "PermDock"): string {
  return quoteSqlTable(qualifySqlTable(name), prefix);
}

/** A `text[]` literal of `values`, each quoted by `quoteSqlLiteral`. */
export function sqlTextArray(values: readonly string[]): string {
  return values.length === 0
    ? `'{}'::text[]`
    : `array[${values.map(quoteSqlLiteral).join(", ")}]::text[]`;
}

export type SqlCommand = "select" | "insert" | "update" | "delete";

/**
 * The SQL command a default verb runs: `read`, `list` and `get` select,
 * `create` inserts, `update` and `delete` keep their name.
 */
export function defaultSqlCommand(action: string): SqlCommand | undefined {
  switch (action) {
    case "read":
    case "list":
    case "get":
      return "select";
    case "create":
      return "insert";
    case "update":
      return "update";
    case "delete":
      return "delete";
    default:
      return undefined;
  }
}
