import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subjectFromSupabase } from "permdock/supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { run } from "./support/cli-run.ts";

const MEMBER = "00000000-0000-4000-8000-0000000000f1";
const LONER = "00000000-0000-4000-8000-0000000000f2";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to supabase_auth_admin, authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
grant select on auth.users to supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${MEMBER}'), ('${LONER}');
create table memberships (user_id uuid not null, scope text not null, scope_id text not null, role text not null);
insert into memberships values
  ('${MEMBER}', 'organization', 'T', 'owner'),
  ('${MEMBER}', 'organization', 'B', 'owner');
`;

describe("the token hook with supabase.hook.membershipsClaim false", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-claim-off-"));
  const db = new PGlite();

  beforeAll(async () => {
    const generated = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--schemas",
        "migrations",
        "--split",
        "helpers,hook",
        "--out",
        `${dir}/{part}.sql`,
      ],
      { cwd: join(import.meta.dirname, "../fixtures/hook-bench/off") },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    await db.exec(SETUP);
    await db.exec(readFileSync(`${dir}/helpers.sql`, "utf8"));
    await db.exec(readFileSync(`${dir}/hook.sql`, "utf8"));
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db.close();
  });

  async function as<T>(
    role: string,
    sub: string | null,
    sql: string,
    values: unknown[] = [],
  ): Promise<T> {
    await db.exec("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        sub === null ? "" : JSON.stringify({ sub, role }),
      ]);
      await db.exec(`set local role ${role}`);
      const { rows } = await db.query<{ readonly value: T }>(sql, values);
      // SAFETY: each query selects one row with a `value` column of the type the caller names.
      return rows[0]?.value as T;
    } finally {
      await db.exec("rollback");
    }
  }

  const mint = (user: string, method = "password") =>
    as<Record<string, unknown>>(
      "supabase_auth_admin",
      null,
      "select permdock.custom_access_token_hook($1::jsonb) -> 'claims' as value",
      [
        JSON.stringify({
          user_id: user,
          authentication_method: method,
          claims: {
            sub: user,
            role: "authenticated",
            app_metadata: { active_organization: "T" },
          },
        }),
      ],
    );

  it("writes no entry, marks the claim truncated and keeps the active tenant", async () => {
    const claims = await mint(MEMBER);
    expect(claims).toMatchObject({
      memberships: [],
      memberships_truncated: true,
      tenant_id: "T",
    });
    const refreshed = await mint(MEMBER, "token_refresh");
    expect(refreshed).toMatchObject({
      memberships: [],
      memberships_truncated: true,
    });
  });

  it("leaves a user without memberships unmarked", async () => {
    const claims = await mint(LONER);
    expect(claims["memberships"]).toStrictEqual([]);
    expect(claims).not.toHaveProperty("memberships_truncated");
    expect(claims).not.toHaveProperty("tenant_id");
  });

  it("hands readers a truncated principal and the database the memberships", async () => {
    const subject = subjectFromSupabase(await mint(MEMBER));
    expect(subject.principal).toMatchObject({
      id: MEMBER,
      memberships: [],
      membershipsTruncated: true,
    });
    const record = await as<{
      readonly memberships: readonly { readonly id: string }[];
    }>("authenticated", MEMBER, "select permdock.permdock_subject() as value");
    expect(
      record.memberships.map((entry) => entry.id).toSorted(),
    ).toStrictEqual(["B", "T"]);
  });
});
