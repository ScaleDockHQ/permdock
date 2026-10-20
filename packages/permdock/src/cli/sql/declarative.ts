/**
 * A migration's SQL as a declarative schema file: pg-delta diffs the file
 * against the database itself, so a `drop trigger if exists` or
 * `drop policy if exists` before its `create` is an error, and a trigger is
 * `create or replace trigger`. A policy keeps its plain `create policy`.
 */
export function declarativeSql(sql: string): string {
  return sql
    .replaceAll(/^drop (?:trigger|policy) if exists [^;\n]+;\n/gmu, "")
    .replaceAll(
      /^create (constraint )?trigger /gmu,
      (_match, constraint: string | undefined) =>
        `create or replace ${constraint ?? ""}trigger `,
    );
}
