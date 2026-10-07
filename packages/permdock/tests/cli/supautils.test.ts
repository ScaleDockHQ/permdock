import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { emitSql, migrationSql } from "../../src/cli/rls-emit.ts";
import { supautilsRejections } from "../../src/cli/supautils.ts";

const GOLDEN = path.join(import.meta.dirname, "fixtures/golden");

describe("supautilsRejections", () => {
  it.each([
    ["alter role anon nologin", "changes the reserved role anon"],
    ['alter user "anon" nologin', "changes the reserved role anon"],
    ["alter role anon password 'x'", "changes the reserved role anon"],
    [
      "alter role authenticated noinherit",
      "changes the reserved role authenticated",
    ],
    [
      "alter role authenticator connection limit 5",
      "changes the reserved role authenticator",
    ],
    [
      "alter role service_role rename to sr",
      "changes the reserved role service_role",
    ],
    [
      "alter role supabase_auth_admin set search_path = auth",
      "changes the reserved role supabase_auth_admin",
    ],
    [
      "alter role dashboard_user set statement_timeout = '1s'",
      "changes the reserved role dashboard_user",
    ],
    ["drop role anon", "drops the reserved role anon"],
    ["drop role if exists app_x, anon", "drops the reserved role anon"],
    [
      "drop user supabase_auth_admin",
      "drops the reserved role supabase_auth_admin",
    ],
    [
      "grant authenticator to app_user",
      "grants membership in the reserved role authenticator",
    ],
    [
      "grant app_user, authenticator to postgres",
      "grants membership in the reserved role authenticator",
    ],
    [
      "grant authenticator to app_user with admin option",
      "grants membership in the reserved role authenticator",
    ],
    [
      "grant supabase_auth_admin to app_user",
      "grants membership in the reserved role supabase_auth_admin",
    ],
    [
      "grant pg_read_server_files to app_user",
      "grants membership in the reserved role pg_read_server_files",
    ],
    [
      "create role app_user in role authenticator",
      "grants membership in the reserved role authenticator",
    ],
    [
      "alter group authenticator add user app_user",
      "grants membership in the reserved role authenticator",
    ],
  ])("rejects %s", (sql, reason) => {
    expect(supautilsRejections(sql)).toEqual([{ line: 1, reason }]);
  });

  it.each([
    "alter role authenticated set statement_timeout = '8s'",
    "alter role anon reset statement_timeout",
    "alter role anon in database postgres set statement_timeout = '1s'",
    "alter role app_user nologin",
    "alter group anon add user app_user",
    "drop role if exists app_user",
    "grant authenticated to app_user",
    "grant app_user to authenticator",
    "grant select on table public.doc to anon, authenticated",
    "grant usage on schema permdock to authenticated",
    "create role app_user nologin noinherit",
    "create role app_user role authenticator",
    "comment on role anon is 'x'",
    "create event trigger et on ddl_command_end execute function f()",
  ])("allows %s", (sql) => {
    expect(supautilsRejections(sql)).toEqual([]);
  });

  it("ignores comments and string literals and reports the statement's line", () => {
    expect(
      supautilsRejections(
        "-- drop role anon;\nselect 'grant authenticator to x';\n\ndrop role anon;",
      ),
    ).toEqual([{ line: 4, reason: "drops the reserved role anon" }]);
  });

  it.each(readdirSync(GOLDEN).filter((file) => file.endsWith(".sql")))(
    "finds nothing in the golden %s",
    (file) => {
      expect(
        supautilsRejections(readFileSync(path.join(GOLDEN, file), "utf8")),
      ).toEqual([]);
    },
  );
});

describe("the supautils guard", () => {
  it.each([
    ["emitSql", () => emitSql([], "alter role anon nologin;")],
    [
      "migrationSql",
      () =>
        migrationSql([], "select 1;\ngrant authenticator to app;", false, []),
    ],
  ])("refuses a rejected statement from %s", (_name, emit) => {
    expect(emit).toThrow(
      /^PermDock CLI: generated SQL line \d+ (changes the reserved role anon|grants membership in the reserved role authenticator), which supautils rejects on Supabase$/u,
    );
  });
});
