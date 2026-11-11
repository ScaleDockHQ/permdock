import type { SubjectRecord } from "permdock";

import { PGlite } from "@electric-sql/pglite";
import { expandBootstrapPermissions } from "better-supabase/server";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memorySubjectCache } from "permdock";
import { readSubjectRecord } from "permdock/supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { run } from "./support/cli-run.ts";

const OWNER = "00000000-0000-4000-8000-0000000000e1";
const SUSPENDED = "00000000-0000-4000-8000-0000000000e2";
const CROWDED = "00000000-0000-4000-8000-0000000000e3";
const PLATFORM = "00000000-0000-4000-8000-0000000000e4";
const USERS = [OWNER, SUSPENDED, CROWDED, PLATFORM];
const TEAM = (n: number): string =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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
insert into auth.users (id) values ${USERS.map((id) => `('${id}')`).join(", ")};
create table memberships (user_id uuid not null, scope text not null, scope_id text not null, role text, via text);
insert into memberships values
  ('${OWNER}', 'organization', 'T', 'owner', 'staff'),
  ('${OWNER}', 'organization', 'B', 'viewer', 'staff'),
  ('${OWNER}', 'organization', 'X', 'owner', 'staff'),
  ('${SUSPENDED}', 'organization', 'T', 'admin', 'staff'),
  ('${CROWDED}', 'organization', 'T', 'member', 'staff');
create table profiles (id uuid primary key, disabled_at timestamptz);
insert into profiles select id, null from auth.users;
update profiles set disabled_at = now() where id = '${SUSPENDED}';
create table organization (id text primary key, disabled_at timestamptz);
insert into organization values ('T', null), ('B', null), ('X', now());
create table team_members (team_id uuid not null, organization_id text not null, user_id uuid not null, disabled_at timestamptz);
insert into team_members values
  ('${TEAM(1)}', 'T', '${OWNER}', null),
  ('${TEAM(2)}', 'T', '${OWNER}', now()),
  ('${TEAM(3)}', 'X', '${OWNER}', null),
  ('${TEAM(4)}', 'B', '${OWNER}', null),
  ('${TEAM(5)}', 'T', '${SUSPENDED}', null);
insert into team_members select ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'T', '${CROWDED}', null from generate_series(10, 60) g;
`;

const FIXTURE = join(import.meta.dirname, "../fixtures/readers");

/** The functions the token hook and better-supabase's bootstrap call. */
const READERS = {
  "permdock.memberships_for(uuid)": "supabase_auth_admin",
  "permdock.memberships_for(uuid, text)": "nobody",
  "permdock.global_roles_for(uuid)": "supabase_auth_admin",
  "permdock.member_team_ids_for(uuid, text)": "supabase_auth_admin",
  "permdock.subject_for(uuid)": "nobody",
  "permdock.subject_for(uuid, text)": "nobody",
} as const;

describe("the hook's readers against Postgres", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-readers-"));
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
    await db.exec(
      `insert into permdock.user_roles (user_id, role) values ('${PLATFORM}', 'platform-admin')`,
    );
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db.close();
  });

  async function one<T>(sql: string, values: unknown[] = []): Promise<T> {
    const { rows } = await db.query<{ readonly value: T }>(sql, values);
    // SAFETY: each query selects one row with a `value` column of the type the caller names.
    return rows[0]?.value as T;
  }

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
      return await one<T>(sql, values);
    } finally {
      await db.exec("rollback");
    }
  }

  it("runs every reader as security definer, without an auth.uid() comparison", async () => {
    for (const signature of Object.keys(READERS)) {
      const row = await one<{
        readonly definer: boolean;
        readonly source: string;
      }>(
        "select jsonb_build_object('definer', p.prosecdef, 'source', p.prosrc) as value from pg_proc p where p.oid = $1::regprocedure",
        [signature],
      );
      expect({ signature, definer: row.definer }).toStrictEqual({
        signature,
        definer: true,
      });
      expect(row.source).not.toContain("auth.uid()");
    }
  });

  it("grants execute to supabase_auth_admin only", async () => {
    for (const [signature, holder] of Object.entries(READERS)) {
      for (const role of [
        "supabase_auth_admin",
        "authenticated",
        "anon",
        "public",
      ]) {
        const allowed = await one<boolean>(
          "select has_function_privilege($1, $2, 'execute') as value",
          [role, signature],
        );
        expect({ role, signature, allowed }).toStrictEqual({
          role,
          signature,
          allowed: role === holder,
        });
      }
    }
  });

  it("drops a suspended user's entries and a suspended tenant's", async () => {
    const tenants = await one<readonly string[]>(
      `select coalesce(jsonb_agg(e.entry ->> 'id' order by e.entry ->> 'id'), '[]'::jsonb) as value from permdock.memberships_for('${OWNER}') e`,
    );
    expect(tenants).toStrictEqual(["B", "T"]);
    const suspended = await one<number>(
      `select count(*)::int as value from permdock.memberships_for('${SUSPENDED}')`,
    );
    expect(suspended).toBe(0);
    const inSuspendedTenant = await one<number>(
      `select count(*)::int as value from permdock.memberships_for('${OWNER}', 'X')`,
    );
    expect(inSuspendedTenant).toBe(0);
  });

  it("reads teams without disabled rows, suspended tenants or suspended users", async () => {
    const teams = await one<readonly string[]>(
      `select coalesce(jsonb_agg(t.id order by t.id), '[]'::jsonb) as value from permdock.member_team_ids_for('${OWNER}', 'T') t(id)`,
    );
    expect(teams).toStrictEqual([TEAM(1), TEAM(4)]);
    const first = await one<string>(
      `select t.id::text as value from permdock.member_team_ids_for('${OWNER}', 'B') t(id) limit 1`,
    );
    expect(first).toBe(TEAM(4));
    const suspended = await one<number>(
      `select count(*)::int as value from permdock.member_team_ids_for('${SUSPENDED}') t(id)`,
    );
    expect(suspended).toBe(0);
  });

  async function mint(user: string): Promise<Record<string, unknown>> {
    return as<Record<string, unknown>>(
      "supabase_auth_admin",
      null,
      "select permdock.custom_access_token_hook($1::jsonb) -> 'claims' as value",
      [
        JSON.stringify({
          user_id: user,
          authentication_method: "password",
          claims: {
            sub: user,
            role: "authenticated",
            app_metadata: { active_organization: "T" },
          },
        }),
      ],
    );
  }

  it("writes team_ids whole or sets team_ids_truncated, never a prefix", async () => {
    const owner = await mint(OWNER);
    expect(owner["team_ids"]).toStrictEqual([TEAM(1), TEAM(4)]);
    expect(owner).not.toHaveProperty("team_ids_truncated");
    const crowded = await mint(CROWDED);
    expect(crowded).not.toHaveProperty("team_ids");
    expect(crowded["team_ids_truncated"]).toBe(true);
    expect(crowded["memberships"]).toStrictEqual([
      expect.objectContaining({ scope: "organization", id: "T" }),
    ]);
  });

  it("answers permdock_subject(p_tenant) for a tenant the caller is a member of, else null", async () => {
    const subject = (sub: string | null, tenant: string | null) =>
      as<Record<string, unknown> | null>(
        "authenticated",
        sub,
        "select permdock.permdock_subject($1) as value",
        [tenant],
      );
    expect(await subject(OWNER, "T")).toMatchObject({
      id: OWNER,
      active: true,
      tenant: "T",
      memberships: [{ scope: "organization", id: "T", roles: ["owner"] }],
    });
    const all = await as<Record<string, unknown>>(
      "authenticated",
      OWNER,
      "select permdock.permdock_subject() as value",
    );
    expect(all).toMatchObject({ id: OWNER, active: true });
    expect(all).not.toHaveProperty("tenant");
    for (const [sub, tenant] of [
      [OWNER, null],
      [OWNER, "nobody"],
      [OWNER, "X"],
      [SUSPENDED, "T"],
      [PLATFORM, "T"],
      [null, "T"],
    ] as const) {
      expect({
        sub,
        tenant,
        subject: await subject(sub, tenant),
      }).toStrictEqual({ sub, tenant, subject: null });
    }
    await expect(
      as("anon", null, "select permdock.permdock_subject('T') as value"),
    ).rejects.toThrow(/permission denied/u);
  });

  it("seeds a one-tenant record beside the all-tenants one at the same version", async () => {
    const read = async (tenant: string | null) => {
      const sql =
        tenant === null
          ? "select permdock.permdock_subject() as value"
          : "select permdock.permdock_subject($1) as value";
      const record = readSubjectRecord(
        await as("authenticated", OWNER, sql, tenant === null ? [] : [tenant]),
      );
      if (record === undefined) {
        throw new Error(`PermDock test: no subject record for ${tenant}`);
      }
      return record;
    };
    const all = await read(null);
    const scoped = await read("T");
    expect(scoped.authzVersion).toBe(all.authzVersion);
    const cache = memorySubjectCache();
    await cache.seed(all);
    await cache.seed(scoped);
    const tenants = (record: SubjectRecord | null) =>
      record?.memberships.map((membership) => membership.id).toSorted();
    expect(tenants(await cache.record(OWNER, all.authzVersion))).toStrictEqual([
      "B",
      "T",
    ]);
    expect(
      tenants(await cache.record(OWNER, all.authzVersion, undefined, "T")),
    ).toStrictEqual(["T"]);
  });

  it("returns the compact bootstrap wire better-supabase expands", async () => {
    const wire = (sub: string | null, tenant: string | null) =>
      as<Record<string, unknown>>(
        "authenticated",
        sub,
        "select permdock.permdock_bootstrap_permissions($1) as value",
        [tenant],
      );
    const all = await wire(OWNER, null);
    expect(all).toMatchObject({ apiVersion: 1, form: "compact" });
    expect(all["tenants"]).toStrictEqual({
      T: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
      B: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
    });
    expect(all["keys"]).not.toContainEqual(expect.stringContaining("#"));
    const expanded = expandBootstrapPermissions(all);
    expect(expanded?.tenants).toStrictEqual({
      T: [
        "asset.delete",
        "asset.read",
        "asset.update",
        "invoice.read",
        "quote.delete",
        "quote.read",
        "quote.update",
      ],
      B: ["asset.read", "invoice.read", "quote.read"],
    });
    expect(expanded?.platform).toStrictEqual([]);
    expect(
      expandBootstrapPermissions(await wire(OWNER, "B"))?.tenants,
    ).toStrictEqual({ B: ["asset.read", "invoice.read", "quote.read"] });
    for (const tenant of ["X", "nobody"]) {
      expect(
        expandBootstrapPermissions(await wire(OWNER, tenant))?.tenants,
      ).toStrictEqual({});
    }
    expect(
      expandBootstrapPermissions(await wire(PLATFORM, null)),
    ).toStrictEqual({
      apiVersion: 1,
      tenants: {},
      platform: [
        "organization.disable",
        "organization.list",
        "organization.read",
      ],
    });
    expect(
      expandBootstrapPermissions(await wire(null, null))?.tenants,
    ).toStrictEqual({});
  });
});
