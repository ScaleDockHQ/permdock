import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const OWNER = "00000000-0000-4000-8000-0000000000d1";
const CONTACT = "00000000-0000-4000-8000-0000000000d2";
const SUSPENDED = "00000000-0000-4000-8000-0000000000d3";
const USERS = [OWNER, CONTACT, SUSPENDED];
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
grant execute on all functions in schema auth to authenticated, anon;
grant select on auth.users to supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ${USERS.map((id) => `('${id}')`).join(", ")};
create table memberships (
  user_id uuid not null, scope text not null, scope_id text not null, role text,
  via text, expires_at timestamptz, managed_by text, seats text[]
);
insert into memberships values
  ('${OWNER}', 'organization', 'T', 'owner', 'staff', null, null, null),
  ('${OWNER}', 'organization', 'B', 'mechanic', 'staff', null, null, null),
  ('${OWNER}', 'organization', 'X', 'owner', 'staff', null, null, null),
  ('${OWNER}', 'organization', 'N', null, 'staff', null, null, null),
  ('${SUSPENDED}', 'organization', 'T', 'admin', 'staff', null, null, null);
create table customer_contacts (customer_id text not null, organization_id text not null, user_id uuid not null);
insert into customer_contacts values ('A', 'T', '${CONTACT}');
create table profiles (id uuid primary key, disabled_at timestamptz);
insert into profiles select id, null from auth.users;
update profiles set disabled_at = now() where id = '${SUSPENDED}';
create table organization (id text primary key, disabled_at timestamptz);
insert into organization values ('T', null), ('B', null), ('X', now());
`;

const FIXTURE = join(import.meta.dirname, "../fixtures/subject-for");

describe("permdock_subject() against Postgres", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-subject-"));
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
      { cwd: FIXTURE },
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

  async function subjectAs(
    role: "authenticated" | "anon",
    sub: string | null,
  ): Promise<unknown> {
    await db.exec("begin");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        sub === null ? "" : JSON.stringify({ sub, role }),
      ]);
      await db.exec(`set local role ${role}`);
      const { rows } = await db.query<{ readonly subject: unknown }>(
        "select permdock.permdock_subject() as subject",
      );
      return rows[0]?.subject;
    } finally {
      await db.exec("rollback");
    }
  }

  it("returns the signed-in user's subject_for record", async () => {
    const direct = await db.query<{ readonly subject: unknown }>(
      `select permdock.subject_for('${OWNER}') as subject`,
    );
    expect(await subjectAs("authenticated", OWNER)).toStrictEqual(
      direct.rows[0]?.subject,
    );
    expect(await subjectAs("authenticated", OWNER)).toMatchObject({
      id: OWNER,
      active: true,
    });
  });

  it("returns null for a suspended user", async () => {
    expect(await subjectAs("authenticated", SUSPENDED)).toBeNull();
  });

  it("returns null with no signed-in user", async () => {
    expect(await subjectAs("authenticated", null)).toBeNull();
  });

  it("is not executable by anon", async () => {
    await expect(subjectAs("anon", null)).rejects.toThrow(/permission denied/u);
  });
});
