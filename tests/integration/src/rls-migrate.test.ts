import type { Client } from "pg";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/centrakit-legacy");

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const PLATFORM = id(0xa1);
const MEMBER = id(0xa4);
const ORG_A = id(0xb1);
const ORG_B = id(0xb2);
const CUST_A = id(0xc1);
const CUST_B = id(0xc2);

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
grant authenticated, anon to tester;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to authenticated, anon, supabase_auth_admin;
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${PLATFORM}'), ('${MEMBER}');
create table organizations (id uuid primary key, slug text not null, disabled_at timestamptz);
insert into organizations values ('${ORG_A}', 'acme', null), ('${ORG_B}', 'bolt', null);
create table profiles (user_id uuid primary key, active_organization_id uuid, disabled_at timestamptz);
insert into profiles (user_id) select id from auth.users;
create table memberships (
  user_id uuid not null, scope text not null, scope_id uuid not null, role text not null,
  via text, expires_at timestamptz
);
insert into memberships values ('${MEMBER}', 'organization', '${ORG_A}', 'member', 'staff', null);
create table contacts (
  id uuid primary key, organization_id uuid not null, customer_id uuid not null, user_id uuid
);
create schema permdock;
create table permdock.user_roles (user_id uuid not null, role text not null);
insert into permdock.user_roles values ('${PLATFORM}', 'platform-admin');
create table customers (id uuid primary key, organization_id uuid not null);
insert into customers values ('${CUST_A}', '${ORG_A}'), ('${CUST_B}', '${ORG_B}');
create table quotes (id uuid primary key, organization_id uuid not null, customer_id uuid not null);
grant select, update on customers to authenticated;
grant select on organizations, quotes to authenticated;
`;

/** CentraKit's call shapes, before `rls migrate`. */
const LEGACY = `-- CentraKit domain policies
alter table public.customers enable row level security;
create policy customers_select on public.customers for select to authenticated
  using (organization_id in (select public.org_ids_with_permission('organization.customers.view')));
create policy customers_update on public.customers for update to authenticated
  using (public.has_org_permission(customers.organization_id, 'organization.customers.update'))
  with check (public.authorize_scope('organization', organization_id, 'organization.customers.update'));

alter table public.organizations enable row level security;
create policy organizations_select on public.organizations for select to authenticated
  using (
    public.is_org_member(organizations.id)
    or (select public.is_system_user_with('system.organizations.view'))
  );

alter table public.quotes enable row level security;
create policy quotes_select on public.quotes for select to authenticated using (false);
`;

describe("rls migrate on CentraKit, then verify --introspect with --helpers-only", () => {
  let db: Postgres | undefined;
  let dir = "";
  let migrated = "";
  let rewrote = "";

  const cli = async (args: readonly string[]) => {
    const result = await run(["rls", ...args, "--rbac", "supabase"], {
      cwd: FIXTURE,
    });
    return { code: result.code, out: `${result.stdout}${result.stderr}` };
  };

  const succeed = async (args: readonly string[]) => {
    const result = await cli(args);
    if (result.code !== 0) {
      throw new Error(`rls ${args.join(" ")}: ${result.out}`);
    }
    return result.out;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "permdock-migrate-"));
    writeFileSync(join(dir, "legacy.sql"), LEGACY);
    rewrote = await succeed(["migrate", "--sql", dir, "--write"]);
    migrated = readFileSync(join(dir, "legacy.sql"), "utf8");
    await succeed([
      "generate",
      "--target",
      "sql",
      "--out",
      join(dir, "helpers.sql"),
    ]);
    db = await startPostgres([
      SETUP,
      readFileSync(join(dir, "helpers.sql"), "utf8"),
      migrated,
    ]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function as<T>(sub: string, work: (client: Client) => Promise<T>) {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const client = db.tester;
    return db.as(
      {
        role: "authenticated",
        settings: {
          "request.jwt.claims": JSON.stringify({ sub, role: "authenticated" }),
        },
      },
      () => work(client),
    );
  }

  const ids = async (sub: string, table: string) =>
    as(sub, async (client) =>
      (
        await client.query<{ id: string }>(
          `select id from ${table} order by id`,
        )
      ).rows.map((row) => row.id),
    );

  it("calls only the generated helpers", () => {
    expect(rewrote).toContain("rewrote 5 call(s) in 1 file(s), skipped 0");
    expect(migrated).not.toMatch(
      /org_ids_with_permission|has_org_permission|authorize_scope|is_system_user_with|is_org_member/u,
    );
    expect(migrated).toContain(
      "(select permdock.permitted_organization_ids('customers.read'))",
    );
    expect(migrated).toContain(
      "(organizations.id in (select permdock.member_organization_ids()))",
    );
    expect(migrated).toContain(
      "(select permdock.permdock_has('organizations.read'))",
    );
  });

  it("enforces the migrated policies", async () => {
    expect(await ids(MEMBER, "customers")).toEqual([CUST_A]);
    expect(await ids(MEMBER, "organizations")).toEqual([ORG_A]);
    expect(await ids(PLATFORM, "organizations")).toEqual([ORG_A, ORG_B]);
    expect(await ids(PLATFORM, "customers")).toEqual([]);
  });

  it("finds no drift and names the table that calls no helper", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const verified = await cli(["verify", "--introspect", "--db", db.uri]);
    expect(verified).toMatchObject({ code: 0 });
    expect(verified.out).toContain(
      "info: public.quotes: no policy calls a PermDock helper",
    );
    expect(verified.out).toContain("helpers only: no drift");
  });

  it("checks indexes only on resources rls.tables maps", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const mapped = mkdtempSync(join(tmpdir(), "permdock-mapped-"));
    try {
      writeFileSync(
        join(mapped, "permdock.config.ts"),
        `import legacy from ${JSON.stringify(join(FIXTURE, "permdock.config.ts"))};
const policy = ${JSON.stringify(join(FIXTURE, "../centrakit/policy.ts"))};
export default {
  ...legacy,
  permissions: policy,
  policy,
  rls: { ...legacy.rls, tables: { customers: "customers" } },
};
`,
      );
      const result = await run(
        ["rls", "verify", "--introspect", "--db", db.uri, "--rbac", "supabase"],
        { cwd: mapped },
      );
      expect(result.stdout).toContain(
        "warning: public.customers: no index starts with organization_id",
      );
      expect(result.stdout).not.toContain("public.quotes: no index");
      expect(result.stdout).toContain("helpers only: no drift");
      expect(result.code).toBe(0);
    } finally {
      rmSync(mapped, { recursive: true, force: true });
    }
  });

  it("fails on a seed or key the generator does not write", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    await db.admin.query(
      `insert into permdock.role_permissions (role, permission, grant_key, scope, effect)
       values ('viewer', 'customers.update', 'customers.update', 'organization', 'allow');
       create policy quotes_typo on public.quotes for select to authenticated
         using (organization_id in (select permdock.permitted_organization_ids('quote.read')))`,
    );
    const verified = await cli(["verify", "--introspect", "--db", db.uri]);
    expect(verified.code).toBe(1);
    expect(verified.out).toContain(
      "permdock.role_permissions: unexpected viewer allow customers.update on organization",
    );
    expect(verified.out).toContain(
      "public.quotes: policy quotes_typo passes quote.read, which the policy does not declare, so it always denies",
    );
  });
});
