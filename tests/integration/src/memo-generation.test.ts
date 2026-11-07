import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rlsGenerate, hookGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/assignments-provider");

const ADMIN = "00000000-0000-4000-8000-0000000000f2";
const MEMBER = "00000000-0000-4000-8000-0000000000f3";
const VIEWER = "00000000-0000-4000-8000-0000000000f4";
const NOBODY = "00000000-0000-4000-8000-0000000000f5";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values
  ('${ADMIN}'), ('${MEMBER}'), ('${VIEWER}'), ('${NOBODY}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${ADMIN}', 'admin'),
  ('acme', '${MEMBER}', 'member'),
  ('beta', '${VIEWER}', 'member');
create table public.invitations (organization_id text, email text not null, role text not null);
create table public.job (id text primary key, "orgId" text not null);
insert into public.job values ('acme-job', 'acme'), ('beta-job', 'beta');

create function public.seed_memo(p_user uuid, p_grant text, p_fake text)
returns text[]
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text,
    true
  );
  perform set_config(
    'permdock.m.tenant.k' || (hashtext(p_grant) & 1023)::text,
    jsonb_build_object(
      'k', md5(concat_ws('|',
        (select permdock.permdock_user_id())::text,
        p_grant,
        coalesce((select auth.jwt()) ->> 'authz_ver', ''),
        coalesce(nullif(current_setting('permdock.m.gen', true), ''), '0'),
        statement_timestamp()::text,
        md5(coalesce((select auth.jwt())::text, ''))
      )),
      'ids', to_jsonb(array[p_fake]::text[])
    )::text,
    true
  );
  return array(select permdock.permitted_tenant_ids(p_grant));
end;
$$;

create function public.cycle_delete(p_user uuid, p_grant text)
returns table (first text[], second text[])
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text,
    true
  );
  first := array(select permdock.permitted_tenant_ids(p_grant));
  delete from public.organization_members
  where user_id = p_user and organization_id = 'acme';
  second := array(select permdock.permitted_tenant_ids(p_grant));
  return next;
end;
$$;

create function public.cycle_insert(p_user uuid, p_grant text)
returns table (first text[], second text[])
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text,
    true
  );
  first := array(select permdock.permitted_tenant_ids(p_grant));
  insert into public.organization_members values ('acme', p_user, 'member');
  second := array(select permdock.permitted_tenant_ids(p_grant));
  return next;
end;
$$;

create function public.cycle_permission(p_user uuid, p_grant text)
returns table (first text[], second text[])
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text,
    true
  );
  first := array(select permdock.permitted_tenant_ids(p_grant));
  update permdock.role_permissions
  set grant_key = 'job.none'
  where role = 'admin' and grant_key = p_grant and scope = 'tenant';
  second := array(select permdock.permitted_tenant_ids(p_grant));
  return next;
end;
$$;

create function public.cycle_truncate(p_user uuid, p_grant text)
returns table (first text[], second text[])
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text,
    true
  );
  first := array(select permdock.permitted_tenant_ids(p_grant));
  truncate permdock.role_permissions;
  second := array(select permdock.permitted_tenant_ids(p_grant));
  return next;
end;
$$;

create function public.two_users(p_a uuid, p_b uuid, p_grant text)
returns table (a_ids text[], b_ids text[])
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_a, 'role', 'authenticated')::text,
    true
  );
  a_ids := array(select permdock.permitted_tenant_ids(p_grant));
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_b, 'role', 'authenticated')::text,
    true
  );
  b_ids := array(select permdock.permitted_tenant_ids(p_grant));
  return next;
end;
$$;
`;

const CLAIMS = (sub: string): string =>
  JSON.stringify({ sub, role: "authenticated" });

const CURRENT = (sub: string): string =>
  JSON.stringify({
    sub,
    role: "authenticated",
    authz_ver: 0,
    memberships: [{ scope: "tenant", id: "acme", roles: ["admin"] }],
  });

describe("RLS memo generation against Postgres", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-memo-"));
  let lite: PGlite | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await rlsGenerate(["--target", "sql", "--out", out], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    const hookOut = join(dir, "hook.sql");
    const hook = await hookGenerate(["--out", hookOut], { cwd: FIXTURE });
    if (hook.code !== 0) {
      throw new Error(`hook generate: ${hook.stdout}${hook.stderr}`);
    }
    const hookSql = readFileSync(hookOut, "utf8");
    if (!hookSql.includes("permdock.m.gen")) {
      throw new Error(
        "PermDock: the generated hook does not bump the memo generation",
      );
    }
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(readFileSync(out, "utf8"));
    await lite.exec(hookSql);
    await lite.exec(
      `insert into permdock.permdock_authz_version (user_id, version) values ('${ADMIN}', 0)`,
    );
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  const database = (): PGlite => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    return lite;
  };

  const rolledBack = async <T>(
    work: (tx: PGlite) => Promise<T>,
  ): Promise<T> => {
    const db = database();
    await db.exec("begin");
    try {
      return await work(db);
    } finally {
      await db.exec("rollback");
    }
  };

  it("reuses a matching memo inside one statement and recomputes in the next", async () => {
    await rolledBack(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        CLAIMS(ADMIN),
      ]);
      const seeded = await tx.query<{ readonly ids: string[] }>(
        "select public.seed_memo($1::uuid, $2, $3) as ids",
        [ADMIN, "job.read", "fake"],
      );
      expect(seeded.rows[0]?.ids).toStrictEqual(["fake"]);
      const next = await tx.query<{ readonly ids: string[] }>(
        "select array(select permdock.permitted_tenant_ids('job.read')) as ids",
      );
      expect(next.rows[0]?.ids).toStrictEqual(["acme"]);
    });
  });

  it("sees a deleted membership in the same statement", async () => {
    await rolledBack(async (tx) => {
      const result = await tx.query<{
        readonly first: string[];
        readonly second: string[];
      }>("select * from public.cycle_delete($1::uuid, $2)", [
        MEMBER,
        "job.read",
      ]);
      expect(result.rows[0]?.first).toStrictEqual(["acme"]);
      expect(result.rows[0]?.second).toStrictEqual([]);
    });
  });

  it("sees an inserted membership in the same statement", async () => {
    await rolledBack(async (tx) => {
      const result = await tx.query<{
        readonly first: string[];
        readonly second: string[];
      }>("select * from public.cycle_insert($1::uuid, $2)", [
        NOBODY,
        "job.read",
      ]);
      expect(result.rows[0]?.first).toStrictEqual([]);
      expect(result.rows[0]?.second).toStrictEqual(["acme"]);
    });
  });

  it("sees a changed permission map in the same statement", async () => {
    await rolledBack(async (tx) => {
      const result = await tx.query<{
        readonly first: string[];
        readonly second: string[];
      }>("select * from public.cycle_permission($1::uuid, $2)", [
        ADMIN,
        "job.read",
      ]);
      expect(result.rows[0]?.first).toStrictEqual(["acme"]);
      expect(result.rows[0]?.second).toStrictEqual([]);
    });
  });

  it("sees a truncated permission map in the same statement", async () => {
    await rolledBack(async (tx) => {
      const result = await tx.query<{
        readonly first: string[];
        readonly second: string[];
      }>("select * from public.cycle_truncate($1::uuid, $2)", [
        ADMIN,
        "job.read",
      ]);
      expect(result.rows[0]?.first).toStrictEqual(["acme"]);
      expect(result.rows[0]?.second).toStrictEqual([]);
    });
  });

  it("returns the claim branch ids and the table branch ids for the same user", async () => {
    await rolledBack(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        CURRENT(ADMIN),
      ]);
      const claim = await tx.query<{ readonly ids: string[] }>(
        "select array(select permdock.permitted_tenant_ids('job.read')) as ids",
      );
      expect(claim.rows[0]?.ids).toStrictEqual(["acme"]);
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({
          sub: ADMIN,
          role: "authenticated",
          authz_ver: 1,
          memberships: [{ scope: "tenant", id: "acme", roles: ["admin"] }],
        }),
      ]);
      const table = await tx.query<{ readonly ids: string[] }>(
        "select array(select permdock.permitted_tenant_ids('job.read')) as ids",
      );
      expect(table.rows[0]?.ids).toStrictEqual(["acme"]);
    });
  });

  it("keeps two users apart inside one statement", async () => {
    await rolledBack(async (tx) => {
      const result = await tx.query<{
        readonly a_ids: string[];
        readonly b_ids: string[];
      }>("select * from public.two_users($1::uuid, $2::uuid, $3)", [
        ADMIN,
        VIEWER,
        "job.read",
      ]);
      expect(result.rows[0]?.a_ids).toStrictEqual(["acme"]);
      expect(result.rows[0]?.b_ids).toStrictEqual(["beta"]);
    });
  });
});
