import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { defined } from "./support/defined.ts";
import { startPostgres } from "./support/postgres.ts";
import { generated, hookGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOLDERS = 10_000;

/** Records every Realtime message, so a fan-out shows as a row count. */
const REALTIME = `
create schema if not exists realtime;
create table realtime.sent (payload jsonb, event text, topic text);
create function realtime.send(payload jsonb, event text, topic text, private boolean)
returns void language sql as $$ insert into realtime.sent values (payload, event, topic) $$;
`;

describe(`a custom role edited while ${String(HOLDERS)} users hold it`, () => {
  const OWNER = "00000000-0000-4000-8000-0000000000d1";
  const CONTACT = "00000000-0000-4000-8000-0000000000d2";
  const SUSPENDED = "00000000-0000-4000-8000-0000000000d3";
  const USERS = [OWNER, CONTACT, SUSPENDED];
  const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
create role service_role nologin;
grant authenticated, anon, supabase_auth_admin, service_role to tester;
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

  let db: Postgres | undefined;

  beforeAll(async () => {
    const [helpers, hook] = await generated(
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
        "{dir}/{part}.sql",
      ],
      ["helpers.sql", "hook.sql"],
      { cwd: join(HERE, "../fixtures/hook-token-shape") },
    );
    db = await startPostgres([SETUP, REALTIME, helpers ?? "", hook ?? ""]);
    const admin = defined(db).admin;
    await admin.query("set session_replication_role = replica");
    await admin.query(
      `insert into auth.users (id) select ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, ${String(HOLDERS)}) n`,
    );
    await admin.query(
      `insert into memberships select ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid, 'organization', 'T', 'crew', 'staff', null, null, null from generate_series(1, ${String(HOLDERS)}) n`,
    );
    await admin.query("set session_replication_role = origin");
    await admin.query("analyze");
  }, 300_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("sends one message for the tenant and none per holder", async () => {
    const admin = defined(db).admin;
    await admin.query("truncate realtime.sent");
    const started = performance.now();
    await admin.query(
      "select permdock.permdock_trusted_replace_custom_role_grants('T', 'organization', null, 'crew', array['asset.read'], array[]::text[], array[]::text[])",
    );
    const elapsed = performance.now() - started;
    const sent = await admin.query<{ topic: string; n: string }>(
      "select topic, count(*)::text as n from realtime.sent group by 1 order by 1",
    );
    process.stdout.write(
      `CUSTOM-ROLE-EDIT holders=${String(HOLDERS)} elapsed_ms=${elapsed.toFixed(1)} messages=${JSON.stringify(sent.rows)}\n`,
    );
    expect(sent.rows.every((row) => row.topic === "authz-tenant:T")).toBe(true);
    expect(
      sent.rows.reduce((sum, row) => sum + Number(row.n), 0),
    ).toBeLessThanOrEqual(2);
    expect(
      Number(
        (
          await admin.query<{ n: string }>(
            "select count(*)::text as n from permdock.permdock_authz_version",
          )
        ).rows[0]?.n,
      ),
    ).toBe(0);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe(`a role key renamed while ${String(HOLDERS)} users hold it`, () => {
  const FIXTURE = join(HERE, "../fixtures/supabase-role-sources");
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-rename-holders-"));
    const out = join(dir, "hook.sql");
    const result = await hookGenerate(["--out", out], { cwd: FIXTURE });
    if (result.code !== 0) {
      throw new Error(`hook generate: ${result.stdout}${result.stderr}`);
    }
    const hook = readFileSync(out, "utf8");
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([
      `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
grant usage on schema auth to supabase_auth_admin;
grant select on auth.users to supabase_auth_admin;
create table public.roles (id int primary key, key text not null unique);
insert into public.roles values (1, 'admin'), (2, 'viewer');
create table public.organization_users (organization_id text not null, user_id uuid not null, tier text, role_id int references public.roles (id));
`,
      REALTIME,
      hook,
    ]);
    const admin = defined(db).admin;
    await admin.query(
      `insert into auth.users (id) select ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, ${String(HOLDERS)}) n`,
    );
    await admin.query(
      `insert into public.organization_users select 'T', ('00000000-0000-4000-8100-' || lpad(n::text, 12, '0'))::uuid, 'member', 1 from generate_series(1, ${String(HOLDERS)}) n`,
    );
    await admin.query("analyze");
    await admin.query("truncate realtime.sent");
  }, 300_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("bumps every holder once in one statement", async () => {
    const admin = defined(db).admin;
    await admin.query("delete from permdock.permdock_authz_version");
    await admin.query("truncate realtime.sent");
    const started = performance.now();
    await admin.query(
      "update public.roles set key = 'administrator' where id = 1",
    );
    const elapsed = performance.now() - started;
    const versions = await admin.query<{
      n: string;
      low: string;
      high: string;
    }>(
      "select count(*)::text as n, min(version)::text as low, max(version)::text as high from permdock.permdock_authz_version",
    );
    const sent = await admin.query<{ n: string }>(
      "select count(*)::text as n from realtime.sent",
    );
    process.stdout.write(
      `ROLE-KEY-RENAME holders=${String(HOLDERS)} elapsed_ms=${elapsed.toFixed(1)} messages=${sent.rows[0]?.n ?? "?"}\n`,
    );
    expect(versions.rows[0]).toStrictEqual({
      n: String(HOLDERS),
      low: "1",
      high: "1",
    });
    expect(Number(sent.rows[0]?.n)).toBe(2 * HOLDERS);
    expect(elapsed).toBeLessThan(30_000);
  });
});
