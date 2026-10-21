import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/adopter-cutover");

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const SHARED = "00000000-0000-4000-8000-0000000000a2";
const OTHER = "00000000-0000-4000-8000-0000000000a3";
const MEMBER = "00000000-0000-4000-8000-0000000000a4";
const CLAIMER = "00000000-0000-4000-8000-0000000000a5";
const STRANGER = "00000000-0000-4000-8000-0000000000a6";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
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
  ('${TENANT}'), ('${SHARED}'), ('${OTHER}'), ('${MEMBER}'), ('${CLAIMER}'), ('${STRANGER}');
create table public.app_roles (
  id serial primary key,
  organization_id text,
  name text not null,
  shared boolean not null default false,
  is_system boolean not null default false
);
create table public.app_role_permissions (
  role_id integer not null references public.app_roles on delete cascade,
  permission text not null,
  effect text not null default 'allow',
  level text
);
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role_id integer not null references public.app_roles
);
create table public.account_users (
  user_id uuid not null references auth.users on delete cascade,
  scope text not null default 'tenant',
  scope_id text not null,
  kind text not null
);
create table public.job (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.invite (id text primary key, "orgId" text not null);
insert into public.job values
  ('j-tenant', 'acme', '${TENANT}'),
  ('j-shared', 'acme', '${SHARED}'),
  ('j-other', 'acme', '${OTHER}');
`;

// The legacy editor's data lands while its triggers are off, so the backfill copies it.
const LEGACY = `
alter table public.app_role_permissions disable trigger user;
insert into public.app_roles (organization_id, name, shared, is_system) values
  ('acme', 'reader', false, false),
  ('acme', 'member', false, true),
  (null, 'sharedreader', true, false),
  (null, 'sharedsys', true, true),
  (null, 'staffrole', false, true);
insert into public.organization_members (organization_id, user_id, role_id)
select 'acme', '${TENANT}'::uuid, id from public.app_roles where name = 'reader'
union all select 'acme', '${SHARED}'::uuid, id from public.app_roles where name = 'sharedreader'
union all select 'acme', '${MEMBER}'::uuid, id from public.app_roles where name = 'member';
insert into public.app_role_permissions (role_id, permission, level)
select id, 'job.read', 'own' from public.app_roles where name in ('reader', 'sharedreader', 'sharedsys', 'staffrole')
union all select id, 'invite.create', 'all' from public.app_roles where name = 'reader'
union all select id, 'job.delete', null from public.app_roles where name = 'reader'
union all select id, 'job.bogus', null from public.app_roles where name = 'reader';
`;

const MAPPED = `
insert into public.account_users (user_id, scope_id, kind) values
  ('${OTHER}', 'acme', 'admin'),
  ('${STRANGER}', 'acme', 'user');
`;

const asUser = (sub: string) => ({
  role: "authenticated",
  settings: {
    "request.jwt.claims": JSON.stringify({ sub, role: "authenticated" }),
  },
});

describe("RLS adopter cutover: database mode with an application roles table", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-adopter-cutover-"));
  let db: Postgres | undefined;
  let notices: string[] = [];
  let backfillNotices: string[] = [];

  const started = (): Postgres => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db;
  };

  const ids = async (sub: string, permission: string): Promise<string[]> => {
    const target = started();
    return target.as(asUser(sub), async () =>
      (
        await target.tester.query<{ id: string }>(
          "select id from permdock.permitted_job_rows($1) id order by id",
          [permission],
        )
      ).rows.map((row) => row.id),
    );
  };

  const grants = async (role: string): Promise<string[]> =>
    (
      await started().admin.query<{ entry: string }>(
        "select scope || ':' || permission || coalesce('@' || level, '') || ':' || effect as entry from permdock.custom_role_permissions where role = $1 order by 1",
        [role],
      )
    ).rows.map((row) => row.entry);

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const backfill = join(dir, "backfill.sql");
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--out",
        out,
        "--backfill-out",
        backfill,
      ],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    db = await startPostgres([
      SETUP,
      readFileSync(out, "utf8"),
      LEGACY,
      MAPPED,
    ]);
    db.admin.on("notice", (message) => {
      notices.push(message.message ?? "");
    });
    await db.admin.query(readFileSync(backfill, "utf8"));
    backfillNotices = [...notices];
    await db.admin.query(
      "delete from public.app_role_permissions where permission in ('job.delete', 'job.bogus')",
    );
  }, 240_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  it("copies a global and a shared role marked is_system, and drops the level of a permission without levels", async () => {
    expect(await grants("staffrole")).toStrictEqual([
      "global:job.read@own:allow",
    ]);
    expect(await grants("sharedsys")).toStrictEqual([
      "tenant:job.read@own:allow",
    ]);
    expect(await grants("reader")).toStrictEqual([
      "tenant:invite.create:allow",
      "tenant:job.read@own:allow",
    ]);
    expect(await grants("member")).toStrictEqual([]);
  });

  it("lists the entries the backfill drops once per legacy role", () => {
    const warning = backfillNotices.find((line) => line.includes("dropped"));
    expect(warning).toContain(
      "reader: job.bogus, not a declared permission, job.delete, outside the ceiling of tenant",
    );
  });

  it("reads the own level for a tenant role and a shared role through the id helpers and the row helper", async () => {
    expect(await ids(TENANT, "job.read")).toStrictEqual(["j-tenant"]);
    expect(await ids(SHARED, "job.read")).toStrictEqual(["j-shared"]);
    const target = started();
    const one = async (sub: string, row: string): Promise<boolean> =>
      target.as(
        asUser(sub),
        async () =>
          (
            await target.tester.query<{ ok: boolean }>(
              `select permdock.permitted_job_row(j, 'job.read') as ok from public.job j where id = $1`,
              [row],
            )
          ).rows[0]?.ok ?? false,
      );
    expect(await one(TENANT, "j-tenant")).toBe(true);
    expect(await one(TENANT, "j-other")).toBe(false);
    expect(await one(SHARED, "j-shared")).toBe(true);
    expect(await one(SHARED, "j-tenant")).toBe(false);
  });

  it("maps a column value to a role and gives a value that maps to null no role", async () => {
    expect(await ids(OTHER, "job.delete")).toStrictEqual([
      "j-other",
      "j-shared",
      "j-tenant",
    ]);
    expect(await ids(STRANGER, "job.read")).toStrictEqual([]);
  });

  it("checks the create action of a row value like the insert policy", async () => {
    const target = started();
    const created = async (sub: string): Promise<boolean> =>
      target.as(
        asUser(sub),
        async () =>
          (
            await target.tester.query<{ ok: boolean }>(
              `select permdock.permitted_job_row(row('j-new', 'acme', $1::text)::public.job, 'job.create') as ok`,
              [sub],
            )
          ).rows[0]?.ok ?? false,
      );
    expect(await created(MEMBER)).toBe(true);
    expect(await created(TENANT)).toBe(false);
    expect(await created(STRANGER)).toBe(false);
  });

  it("deletes the grants of a global and a shared role marked is_system with their rows", async () => {
    const admin = started().admin;
    await admin.query(
      "delete from public.app_roles where name in ('staffrole', 'sharedsys')",
    );
    expect(await grants("staffrole")).toStrictEqual([]);
    expect(await grants("sharedsys")).toStrictEqual([]);
  });

  it("rebuilds a tenant, a shared and a global role on every legacy write", async () => {
    const admin = started().admin;
    await admin.query(
      "alter table public.app_role_permissions enable trigger user",
    );
    await admin.query(
      "insert into public.app_roles (organization_id, name, shared, is_system) values (null, 'staffer', false, false)",
    );
    await admin.query(`insert into public.app_role_permissions (role_id, permission, level)
      select id, 'job.read', 'all' from public.app_roles where name in ('reader', 'sharedreader', 'staffer')`);
    expect(await grants("reader")).toStrictEqual([
      "tenant:invite.create:allow",
      "tenant:job.read@all:allow",
      "tenant:job.read@own:allow",
    ]);
    expect(await grants("sharedreader")).toStrictEqual([
      "tenant:job.read@all:allow",
      "tenant:job.read@own:allow",
    ]);
    expect(await grants("staffer")).toStrictEqual([
      "global:job.read@all:allow",
    ]);
    await admin.query(
      "delete from public.app_role_permissions where role_id = (select id from public.app_roles where name = 'reader')",
    );
    expect(await grants("reader")).toStrictEqual([]);
    expect(await ids(TENANT, "job.read")).toStrictEqual([]);
    await admin.query(`insert into public.app_role_permissions (role_id, permission, level)
      select id, 'job.read', 'own' from public.app_roles where name = 'reader'`);
  });

  it("drops an entry outside the ceiling with a warning instead of failing the legacy write", async () => {
    const admin = started().admin;
    notices = [];
    await admin.query(`insert into public.app_role_permissions (role_id, permission, level)
      select id, 'job.delete', null from public.app_roles where name = 'reader'`);
    expect(await grants("reader")).toStrictEqual(["tenant:job.read@own:allow"]);
    expect(notices.some((line) => line.includes("dropped 1 entr"))).toBe(true);
  });

  it("names the problem of a stored entry, and null for a valid one", async () => {
    const problem = async (scope: string, entry: string): Promise<unknown> =>
      (
        await started().admin.query<{ problem: string | null }>(
          "select permdock.permdock_custom_role_entry_problem($1, $2) as problem",
          [scope, entry],
        )
      ).rows[0]?.problem;
    expect(await problem("tenant", "job.read@own")).toBeNull();
    expect(await problem("tenant", "invite.create")).toBeNull();
    expect(await problem("tenant", "job.nope")).toBe("unknown-permission");
    expect(await problem("tenant", "job.read@mine")).toBe("unknown-level");
    expect(await problem("global", "job.update")).toBe("outside-ceiling");
  });

  it("refuses a tenant role named like a declared or a shared role", async () => {
    const admin = started().admin;
    await expect(
      admin.query(
        "insert into public.app_roles (organization_id, name) values ('acme', 'owner')",
      ),
    ).rejects.toThrow(/owner is a declared role/u);
    await expect(
      admin.query(
        "insert into public.app_roles (organization_id, name) values ('acme', 'sharedreader')",
      ),
    ).rejects.toThrow(/sharedreader is a shared role/u);
  });

  it("does not grant a declared role to a tenant row named after it, even without the guard trigger", async () => {
    const admin = started().admin;
    await admin.query(
      'drop trigger "permdock_custom_role_name_guard" on public.app_roles',
    );
    await admin.query(
      "insert into public.app_roles (organization_id, name) values ('acme', 'owner')",
    );
    await admin.query(`insert into public.organization_members (organization_id, user_id, role_id)
      select 'acme', '${CLAIMER}'::uuid, id from public.app_roles where name = 'owner' and organization_id = 'acme' and not is_system`);
    expect(await ids(CLAIMER, "job.delete")).toStrictEqual([]);
    expect(await ids(CLAIMER, "job.read")).toStrictEqual([]);
  });
});
