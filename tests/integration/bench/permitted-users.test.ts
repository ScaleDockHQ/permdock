import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rlsGenerate } from "../src/support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/permitted-users");

const ORGS = 200;
const ADMINS = 30;
const READERS = 300;
const EDITORS = 20;
const STAFF = 20;
const RUNS = 5;

const org = (n: number) =>
  `00000000-0000-4000-8001-${n.toString(16).padStart(12, "0")}`;
const TARGET = org(0);

/**
 * One organization with 30 admins who each belong to all 200 organizations, 300
 * readers, 20 holders of a tenant custom role and 20 global staff: the
 * multi-tenant shape where each per-candidate helper call lists every
 * organization the candidate reaches.
 */
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
create table public.profiles (user_id uuid primary key, disabled_at timestamptz);
create table public.organization_users (
  user_id uuid not null references auth.users on delete cascade,
  organization_id uuid not null,
  role text not null,
  expires_at timestamptz,
  disabled_at timestamptz
);
create index on public.organization_users (user_id);
create index on public.organization_users (organization_id);
create table public.files (id uuid primary key, organization_id uuid not null);
create table public.reports (id uuid primary key, organization_id uuid not null);
insert into auth.users
  select ('00000000-0000-4000-8002-' || lpad(n::text, 12, '0'))::uuid
  from generate_series(1, ${ADMINS + READERS + EDITORS + STAFF}) n;
insert into public.profiles (user_id) select id from auth.users;
`;

const user = (n: string) =>
  `('00000000-0000-4000-8002-' || lpad((${n})::text, 12, '0'))::uuid`;

const SEED = `
insert into public.organization_users (user_id, organization_id, role)
  select ${user("a")}, ('00000000-0000-4000-8001-' || lpad(to_hex(o), 12, '0'))::uuid, 'admin'
  from generate_series(1, ${ADMINS}) a, generate_series(0, ${ORGS - 1}) o;
insert into public.organization_users (user_id, organization_id, role)
  select ${user(`${ADMINS} + r`)}, '${TARGET}', 'reader'
  from generate_series(1, ${READERS}) r;
insert into public.organization_users (user_id, organization_id, role)
  select ${user(`${ADMINS + READERS} + e`)}, '${TARGET}', 'editor'
  from generate_series(1, ${EDITORS}) e;
insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission)
  values ('${TARGET}', 'tenant', null, 'editor', 'files.read');
insert into permdock.user_roles (user_id, role)
  select ${user(`${ADMINS + READERS + EDITORS} + s`)}, 'staff'
  from generate_series(1, ${STAFF}) s;
analyze;
`;

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

describe("permitted_<scope>_users at multi-tenant scale", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-permitted-users-bench-"));
  let lite: PGlite | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await rlsGenerate(
      ["--target", "sql", "--rbac", "supabase", "--out", out],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(readFileSync(out, "utf8"));
    await lite.exec(SEED);
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  async function best(sql: string): Promise<{ ms: number; rows: string[] }> {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    let ms = Number.POSITIVE_INFINITY;
    let rows: string[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const start = performance.now();
      const result = await lite.query<{ user_id: string }>(sql, [
        "files.read",
        TARGET,
      ]);
      ms = Math.min(ms, performance.now() - start);
      rows = result.rows.map((row) => row.user_id);
    }
    return { ms, rows };
  }

  it("answers as the per-candidate helpers do, in less time", async () => {
    const set = await best(
      "select u as user_id from permdock.permitted_tenant_users($1, $2::uuid) u",
    );
    const reference = await best(REFERENCE);
    expect(set.rows).toStrictEqual(reference.rows);
    expect(set.rows).toHaveLength(ADMINS + READERS + EDITORS + STAFF);
    expect(
      set.ms,
      `one query ${set.ms.toFixed(1)} ms, per candidate ${reference.ms.toFixed(1)} ms`,
    ).toBeLessThan(reference.ms);
  });
});
