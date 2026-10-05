import { describe, expect, it } from "vitest";

import {
  group,
  splitUndiffed,
  sqlStatements,
} from "../../src/cli/sql-statements.ts";

describe("sqlStatements", () => {
  it("keeps an unterminated string or dollar-quoted body as the last statement", () => {
    expect(sqlStatements("select 1;\nselect 'open; still open")).toEqual([
      { line: 1, text: "select 1" },
      { line: 2, text: "select 'open; still open" },
    ]);
    expect(
      sqlStatements("select 1;\ncreate function f() as $body$ select 2;"),
    ).toEqual([
      { line: 1, text: "select 1" },
      { line: 2, text: "create function f() as $body$ select 2;" },
    ]);
  });
});

describe("group", () => {
  it("reads an optional group that took no part as empty", () => {
    const match = /^(a)(b)?$/u.exec("a");
    expect(match === null ? undefined : group(match, 2)).toBe("");
  });
});

describe("splitUndiffed", () => {
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
    expect(moved).toEqual([
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
});
