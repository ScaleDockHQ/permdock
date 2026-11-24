import { describe, expect, it } from "vitest";

import {
  group,
  splitUndiffed,
  sqlStatements,
} from "../../src/cli/sql/statements.ts";

describe(sqlStatements, () => {
  it("keeps an unterminated string or dollar-quoted body as the last statement", () => {
    expect(sqlStatements("select 1;\nselect 'open; still open")).toStrictEqual([
      { line: 1, text: "select 1" },
      { line: 2, text: "select 'open; still open" },
    ]);
    expect(
      sqlStatements("select 1;\ncreate function f() as $body$ select 2;"),
    ).toStrictEqual([
      { line: 1, text: "select 1" },
      { line: 2, text: "create function f() as $body$ select 2;" },
    ]);
  });
});

describe("sqlStatements lexing", () => {
  const texts = (sql: string): readonly string[] =>
    sqlStatements(sql).map((statement) => statement.text);

  it("keeps `--` inside a string literal", () => {
    expect(texts("select 'a--b';\nselect 2")).toStrictEqual([
      "select 'a--b'",
      "select 2",
    ]);
  });

  it("does not split a quoted identifier that holds a semicolon", () => {
    expect(texts('select "a;b" from t; select 2')).toStrictEqual([
      'select "a;b" from t',
      "select 2",
    ]);
  });

  it("reads a backslash escape inside an E string", () => {
    expect(texts("select E'it\\'s;x'; select 2")).toStrictEqual([
      "select E'it\\'s;x'",
      "select 2",
    ]);
  });

  it("does not take a backslash as an escape in a plain string", () => {
    expect(texts("select 'a\\'; select 2")).toStrictEqual([
      "select 'a\\'",
      "select 2",
    ]);
  });

  it("reads a dollar tag with digits and ignores a parameter", () => {
    expect(
      texts(
        "create function f() returns int as $a1$ select 1; $a1$; select $1",
      ),
    ).toStrictEqual([
      "create function f() returns int as $a1$ select 1; $a1$",
      "select $1",
    ]);
  });

  it("nests block comments and blanks them", () => {
    expect(
      texts("select /* a /* b; */ c; */ 1;").map((text) =>
        text.replaceAll(/\s+/gu, " "),
      ),
    ).toStrictEqual(["select 1"]);
  });

  it("keeps the line of a statement after non-ASCII text", () => {
    expect(sqlStatements("-- é 😀\nselect 1;\nselect 2")).toStrictEqual([
      { line: 2, text: "select 1" },
      { line: 3, text: "select 2" },
    ]);
  });
});

describe(group, () => {
  it("reads an optional group that took no part as empty", () => {
    const match = /^(a)(b)?$/u.exec("a");
    expect(match === null ? undefined : group(match, 2)).toBe("");
  });
});

describe(splitUndiffed, () => {
  it("moves the schema, function and view privileges and view options supabase db diff drops", () => {
    const sql = [
      "create schema if not exists app;",
      "revoke all on schema app from public;",
      "create table app.rows (id int);",
      "revoke all on table app.rows from anon;",
      "grant select on app.rows to authenticated;",
      "create or replace view app.open as select 1;",
      "create or replace view app.safe with (security_invoker = true) as select 1;",
      "grant select on app.open to authenticated;",
      "revoke all on table app.safe from anon;",
      "grant execute on function app.f(text) to authenticated;",
      "revoke execute on all functions in schema app from public;",
      "create policy p on app.rows for select to authenticated using (true);",
      "",
    ].join("\n");
    const { kept, moved } = splitUndiffed(sql);
    expect(moved).toStrictEqual([
      "revoke all on schema app from public;",
      "alter view app.safe set (security_invoker = true);",
      "grant select on app.open to authenticated;",
      "revoke all on table app.safe from anon;",
      "grant execute on function app.f(text) to authenticated;",
      "revoke execute on all functions in schema app from public;",
    ]);
    expect(kept).toBe(
      [
        "create schema if not exists app;",
        "create table app.rows (id int);",
        "revoke all on table app.rows from anon;",
        "grant select on app.rows to authenticated;",
        "create or replace view app.open as select 1;",
        "create or replace view app.safe with (security_invoker = true) as select 1;",
        "create policy p on app.rows for select to authenticated using (true);",
        "",
      ].join("\n"),
    );
  });

  it("moves a statement with a trailing or inner comment once", () => {
    const sql = [
      "create schema app;",
      "grant usage on schema app to authenticated; -- the data api reads it",
      "grant execute on function app.f(text) -- the helper",
      "  to authenticated;",
      "",
    ].join("\n");
    const { kept, moved } = splitUndiffed(sql);
    expect(moved).toStrictEqual([
      "grant usage on schema app to authenticated;",
      "grant execute on function app.f(text) -- the helper\n  to authenticated;",
    ]);
    expect(kept).toBe("create schema app;\n");
  });
});
