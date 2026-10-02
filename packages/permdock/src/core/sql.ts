/** A bare Postgres identifier PermDock emits unquoted-safe: letters, digits and `_`, not starting with a digit. */
export const SQL_IDENT: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A validated, double-quoted identifier; anything outside `SQL_IDENT` throws. */
export function quoteSqlIdent(name: string, prefix = 'PermDock'): string {
  if (!SQL_IDENT.test(name)) {
    throw new TypeError(`${prefix}: unsafe SQL identifier '${name}'`);
  }
  return `"${name}"`;
}

/** A schema-qualified name, each part validated by `quoteSqlIdent`. */
export function quoteSqlTable(name: string, prefix = 'PermDock'): string {
  return name
    .split('.')
    .map((part) => quoteSqlIdent(part, prefix))
    .join('.');
}

/** A single-quoted string literal with embedded quotes doubled. */
export function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A double-quoted identifier read back from a database, embedded quotes doubled rather than refused. */
export function escapeSqlIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
