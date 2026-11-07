/**
 * A migration's SQL as a declarative schema file: pg-delta diffs the file
 * against the database itself, so a `drop trigger if exists` or `drop policy if
 * exists` before its `create` is an error, and a trigger is `create or replace
 * trigger`. A constraint trigger stays `create constraint trigger`, because
 * pg-delta has no `create or replace constraint trigger`. A policy keeps its
 * plain `create policy`. A schema keeps `if not exists`: the helpers and the
 * hook are separate files, and the shadow load applies both.
 */
export function declarativeSql(sql: string): string {
  return sql
    .replaceAll(/^drop (?:trigger|policy) if exists [^;\n]+;\n/gmu, "")
    .replaceAll(/^create trigger /gmu, "create or replace trigger ")
    .replaceAll(
      /^(create (?:unique index|index|table|type|extension)) if not exists /gmu,
      "$1 ",
    );
}
