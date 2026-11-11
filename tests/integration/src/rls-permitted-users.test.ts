import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/permitted-users");

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const ORG_A = id(0xa0);
const ORG_B = id(0xb0);
const ORG_NONE = id(0xc0);
const ADMIN = id(1);
const READER = id(2);
const BLOCKED = id(3);
const EXPIRED = id(4);
const DISABLED = id(5);
const SUSPENDED_USER = id(6);
const STAFF = id(7);
const STAFF_DENIED = id(8);
const EDITOR = id(9);
const TIER2 = id(10);
const GATED = id(11);
const USERS = [
  ADMIN,
  READER,
  BLOCKED,
  EXPIRED,
  DISABLED,
  SUSPENDED_USER,
  STAFF,
  STAFF_DENIED,
  EDITOR,
  TIER2,
  GATED,
];

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
insert into auth.users (id) values ${USERS.map((user) => `('${user}')`).join(", ")};
create table public.profiles (user_id uuid primary key, disabled_at timestamptz);
insert into public.profiles (user_id, disabled_at)
  select u.id, case when u.id = '${SUSPENDED_USER}' then now() end from auth.users u;
create table public.organization_users (
  user_id uuid not null references auth.users on delete cascade,
  organization_id uuid not null,
  role text not null,
  expires_at timestamptz,
  disabled_at timestamptz
);
insert into public.organization_users (user_id, organization_id, role, expires_at, disabled_at) values
  ('${ADMIN}', '${ORG_A}', 'admin', null, null),
  ('${READER}', '${ORG_A}', 'reader', null, null),
  ('${BLOCKED}', '${ORG_A}', 'reader', null, null),
  ('${BLOCKED}', '${ORG_A}', 'blocked', null, null),
  ('${EXPIRED}', '${ORG_A}', 'reader', now() - interval '1 day', null),
  ('${DISABLED}', '${ORG_A}', 'reader', null, now()),
  ('${SUSPENDED_USER}', '${ORG_A}', 'reader', null, null),
  ('${STAFF_DENIED}', '${ORG_B}', 'reader', null, null),
  ('${EDITOR}', '${ORG_A}', 'editor', null, null),
  ('${EDITOR}', '${ORG_B}', 'editor', null, null),
  ('${GATED}', '${ORG_A}', 'reader', null, null),
  ('${GATED}', '${ORG_A}', 'gate', null, null);
create table public.files (id uuid primary key, organization_id uuid not null);
create table public.reports (id uuid primary key, organization_id uuid not null);
`;

const SEED = `
insert into permdock.user_roles (user_id, role) values
  ('${STAFF}', 'staff'),
  ('${STAFF_DENIED}', 'staff'),
  ('${STAFF_DENIED}', 'suspended'),
  ('${SUSPENDED_USER}', 'staff'),
  ('${TIER2}', 'tier2');
insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission) values
  ('${ORG_A}', 'tenant', null, 'editor', 'files.update'),
  ('${ORG_B}', 'tenant', null, 'editor', 'files.read'),
  (null, 'global', null, 'tier2', 'files.update');
insert into permdock.custom_role_includes (tenant_id, scope, scope_id, role, include_role) values
  (null, 'global', null, 'tier2', 'auditor'),
  ('${ORG_A}', 'tenant', null, 'gate', 'blocked');
`;

/**
 * The body every release before the set-based query ran: two helper calls per
 * candidate.
 */
const REFERENCE = `
select c.user_id
from (
  select m.user_id from public.organization_users m where m.organization_id = $2
  union
  select ur.user_id from permdock.user_roles ur
) c(user_id)
where c.user_id is not null
  and (
    $2 in (select permdock.permitted_tenant_ids_by_permission_for(c.user_id, $1))
    or permdock.permdock_has_permission_for(c.user_id, $1)
  )
order by 1`;

const PERMISSIONS = ["files.read", "files.update", "reports.read", "nope.read"];

describe("permitted_<scope>_users as one query", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-permitted-users-"));
  let lite: PGlite | undefined;
  let generated = "";

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await rlsGenerate(
      ["--target", "sql", "--rbac", "supabase", "--out", out],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    generated = readFileSync(out, "utf8");
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(generated);
    await lite.exec(SEED);
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

  const users = async (permission: string, org: string) =>
    (
      await database().query<{ user_id: string }>(
        "select u as user_id from permdock.permitted_tenant_users($1, $2::uuid) u",
        [permission, org],
      )
    ).rows.map((row) => row.user_id);

  const reference = async (permission: string, org: string) =>
    (
      await database().query<{ user_id: string }>(REFERENCE, [permission, org])
    ).rows.map((row) => row.user_id);

  it("calls no per-candidate helper", () => {
    const body = generated.slice(
      generated.indexOf('permdock".permitted_tenant_users('),
    );
    const fn = body.slice(0, body.indexOf("$$;"));
    expect(fn).toContain("pdk_h");
    expect(fn).not.toMatch(/_by_permission_for|permdock_has_permission_for/u);
  });

  it("lists who holds a permission through declared, custom and global roles", async () => {
    expect(await users("files.read", ORG_A)).toStrictEqual(
      [ADMIN, READER, STAFF].toSorted(),
    );
    expect(await users("files.read", ORG_B)).toStrictEqual(
      [EDITOR, STAFF, STAFF_DENIED].toSorted(),
    );
    expect(await users("files.update", ORG_A)).toStrictEqual(
      [ADMIN, EDITOR].toSorted(),
    );
    expect(await users("reports.read", ORG_NONE)).toStrictEqual([TIER2]);
    expect(await users("nope.read", ORG_A)).toStrictEqual([]);
  });

  it("answers what the per-candidate helpers answer for every permission and instance", async () => {
    for (const permission of PERMISSIONS) {
      for (const org of [ORG_A, ORG_B, ORG_NONE]) {
        expect(
          await users(permission, org),
          `${permission} on ${org}`,
        ).toStrictEqual(await reference(permission, org));
      }
    }
  });

  it("follows a change to roles, custom roles and suspension", async () => {
    const db = database();
    await db.exec(`
update public.profiles set disabled_at = now() where user_id = '${STAFF}';
delete from permdock.custom_role_includes where role = 'gate';
insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect)
  values ('${ORG_A}', 'tenant', null, 'editor', 'files.read', 'deny');
update public.organization_users set expires_at = null where user_id = '${EXPIRED}';
`);
    for (const permission of PERMISSIONS) {
      for (const org of [ORG_A, ORG_B, ORG_NONE]) {
        expect(
          await users(permission, org),
          `${permission} on ${org}`,
        ).toStrictEqual(await reference(permission, org));
      }
    }
    expect(await users("files.read", ORG_A)).toStrictEqual(
      [ADMIN, READER, EXPIRED, GATED].toSorted(),
    );
  });
});
