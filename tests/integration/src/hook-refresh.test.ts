import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";
import { generated } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/hook-refresh");

const USER = "00000000-0000-4000-8000-0000000000f1";
const OTHER = "00000000-0000-4000-8000-0000000000f2";
const USERS = [USER, OTHER];

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
  via text, managed_by text, seats text[]
);
create table customer_contacts (customer_id text not null, organization_id text not null, user_id uuid not null);
create table profiles (id uuid primary key, disabled_at timestamptz);
insert into profiles select id, null from auth.users;
create table organization (id text primary key, disabled_at timestamptz);
insert into organization values ('T', null), ('B', null);
`;

type Claims = Record<string, unknown>;

const REQUIRED = [
  "iss",
  "aud",
  "exp",
  "iat",
  "sub",
  "role",
  "aal",
  "session_id",
  "email",
  "phone",
  "is_anonymous",
] as const;

/** The claims Supabase Auth hands the hook before it runs. */
function baseClaims(): Claims {
  return {
    aud: "authenticated",
    exp: 1_900_000_000,
    iat: 1_899_996_400,
    iss: "https://abcdefghijklmnopqrst.supabase.co/auth/v1",
    sub: USER,
    email: "someone@example.com",
    phone: "",
    app_metadata: { provider: "email", active_organization: "T" },
    user_metadata: {},
    role: "authenticated",
    aal: "aal1",
    amr: [{ method: "token_refresh", timestamp: 1_899_996_400 }],
    session_id: "11111111-2222-4333-8444-555555555555",
    is_anonymous: false,
  };
}

type Mint = {
  readonly user?: string;
  readonly method?: string;
  readonly claims?: Claims;
};

describe("the hook on a token refresh and for an OAuth client", () => {
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
      { cwd: FIXTURE },
    );
    db = await startPostgres([SETUP, helpers ?? "", hook ?? ""]);
    await db.admin.query("set track_functions = 'all'");
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  const target = (): Postgres => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db;
  };

  async function reset(): Promise<void> {
    const admin = target().admin;
    await admin.query(
      "truncate memberships, customer_contacts, permdock.user_roles",
    );
    await admin.query("update profiles set disabled_at = null");
    await admin.query(
      `insert into memberships values
        ('${OTHER}', 'organization', 'T', 'owner', 'staff', null, null),
        ('${OTHER}', 'organization', 'B', 'owner', 'staff', null, null),
        ('${USER}', 'organization', 'T', 'admin', 'staff', null, null),
        ('${USER}', 'organization', 'B', 'mechanic', 'staff', null, null)`,
    );
    await admin.query(
      `insert into permdock.user_roles values ('${USER}', 'platform-support')`,
    );
  }

  async function mint({
    user = USER,
    method = "token_refresh",
    claims = baseClaims(),
  }: Mint = {}): Promise<Claims> {
    const result = await target().admin.query<{ event: { claims: Claims } }>(
      "select permdock.custom_access_token_hook($1::jsonb) as event",
      [
        JSON.stringify({
          user_id: user,
          authentication_method: method,
          claims,
        }),
      ],
    );
    return result.rows[0]?.event.claims ?? {};
  }

  /** Signs in, then refreshes with the claims of the token that sign-in issued. */
  async function refresh(
    mutate?: (issued: Claims) => Claims,
  ): Promise<{ readonly issued: Claims; readonly refreshed: Claims }> {
    const issued = await mint({ method: "password" });
    const incoming = { ...baseClaims(), ...(mutate?.(issued) ?? issued) };
    return { issued, refreshed: await mint({ claims: incoming }) };
  }

  const ids = (claims: Claims): string[] =>
    // SAFETY: the hook writes memberships as an array of { id, ... } objects.
    (claims["memberships"] as { id: string }[])
      .map((entry) => entry.id)
      .toSorted();

  const calls = async (): Promise<number> => {
    const admin = target().admin;
    await admin.query("select pg_stat_force_next_flush()");
    const result = await admin.query<{ n: string }>(
      "select coalesce(sum(calls), 0)::text as n from pg_stat_user_functions where funcname = 'memberships_for'",
    );
    return Number(result.rows[0]?.n);
  };

  it("reuses the memberships of a refresh whose authz_ver is current", async () => {
    await reset();
    const before = await calls();
    const { issued, refreshed } = await refresh();
    const during = (await calls()) - before;
    expect(ids(issued)).toStrictEqual(["B", "T"]);
    expect(ids(refreshed)).toStrictEqual(["B", "T"]);
    expect(refreshed["authz_ver"]).toBe(issued["authz_ver"]);
    expect(refreshed["roles"]).toStrictEqual(issued["roles"]);
    expect(refreshed["tenant_id"]).toBe("T");
    // the sign-in reads memberships_for once; the refresh reads it not at all
    expect(during).toBe(1);
  });

  it("drops a revoked membership on a refresh", async () => {
    await reset();
    const issued = await mint({ method: "password" });
    await target().admin.query(
      `delete from memberships where user_id = '${USER}' and scope_id = 'B'`,
    );
    const refreshed = await mint({ claims: { ...baseClaims(), ...issued } });
    expect(ids(refreshed)).toStrictEqual(["T"]);
    expect(Number(refreshed["authz_ver"])).toBeGreaterThan(
      Number(issued["authz_ver"]),
    );
  });

  it("drops a changed role on a refresh", async () => {
    await reset();
    const issued = await mint({ method: "password" });
    await target().admin.query(
      `update memberships set role = 'viewer' where user_id = '${USER}' and scope_id = 'T'`,
    );
    const refreshed = await mint({ claims: { ...baseClaims(), ...issued } });
    // SAFETY: the hook writes memberships as an array of { id, roles, ... } objects.
    const roles = (
      refreshed["memberships"] as { id: string; roles: string[] }[]
    )
      .filter((entry) => entry.id === "T")
      .flatMap((entry) => entry.roles);
    expect(roles).toStrictEqual(["viewer"]);
  });

  it("drops a removed global role on a refresh", async () => {
    await reset();
    const issued = await mint({ method: "password" });
    await target().admin.query(
      `delete from permdock.user_roles where user_id = '${USER}'`,
    );
    const refreshed = await mint({ claims: { ...baseClaims(), ...issued } });
    expect(issued["roles"]).toStrictEqual(["platform-support"]);
    expect(refreshed["roles"]).toStrictEqual([]);
    expect(refreshed["user_role"]).toBeUndefined();
  });

  it("drops a removed custom-role holder and reads the custom-role version again", async () => {
    await reset();
    await target().admin.query(
      "select permdock.permdock_trusted_replace_custom_role_grants('T', 'organization', null, 'crew', array['asset.read'], array[]::text[], array[]::text[])",
    );
    await target().admin.query(
      `insert into memberships values ('${USER}', 'organization', 'T', 'crew', 'staff', null, null)`,
    );
    const issued = await mint({ method: "password" });
    expect(JSON.stringify(issued["memberships"])).toContain("crew");
    await target().admin.query(
      "select permdock.permdock_trusted_replace_custom_role_grants('T', 'organization', null, 'crew', array['asset.read', 'asset.update'], array[]::text[], array[]::text[])",
    );
    const edited = await mint({ claims: { ...baseClaims(), ...issued } });
    expect(JSON.stringify(edited["memberships"])).toContain("crew");
    expect(Number(edited["custom_roles_ver"])).toBeGreaterThan(
      Number(issued["custom_roles_ver"]),
    );
    await target().admin.query(
      `delete from memberships where user_id = '${USER}' and role = 'crew'`,
    );
    const removed = await mint({ claims: { ...baseClaims(), ...edited } });
    expect(JSON.stringify(removed["memberships"])).not.toContain("crew");
  });

  it("gives a suspended user empty claims on a refresh", async () => {
    await reset();
    const issued = await mint({ method: "password" });
    await target().admin.query(
      `update profiles set disabled_at = now() where id = '${USER}'`,
    );
    const refreshed = await mint({ claims: { ...baseClaims(), ...issued } });
    expect(refreshed["memberships"]).toStrictEqual([]);
    expect(refreshed["roles"]).toStrictEqual([]);
    expect(refreshed["tenant_id"]).toBeUndefined();
  });

  it("takes the full path when authz_ver is stale, missing or malformed", async () => {
    await reset();
    const issued = await mint({ method: "password" });
    await target().admin.query(
      `insert into memberships values
        ('${OTHER}', 'organization', 'N', 'owner', 'staff', null, null),
        ('${USER}', 'organization', 'N', 'admin', 'staff', null, null)`,
    );
    const stale = await mint({ claims: { ...baseClaims(), ...issued } });
    expect(ids(stale)).toStrictEqual(["B", "N", "T"]);
    const forged = {
      ...baseClaims(),
      ...stale,
      authz_ver: Number(stale["authz_ver"]) + 1,
    };
    for (const authz_ver of [
      undefined,
      "7",
      null,
      Number(stale["authz_ver"]) - 1,
    ]) {
      const claims = { ...baseClaims(), ...stale, authz_ver };
      const result = await mint({ claims });
      expect(ids(result)).toStrictEqual(["B", "N", "T"]);
      expect(result["authz_ver"]).toBe(stale["authz_ver"]);
    }
    expect(forged.authz_ver).toBeGreaterThan(Number(stale["authz_ver"]));
  });

  it("takes the full path for a truncated token and for a method other than a refresh", async () => {
    await reset();
    const issued = await mint({ method: "password" });
    const truncated = await mint({
      claims: {
        ...baseClaims(),
        ...issued,
        memberships: [],
        memberships_truncated: true,
      },
    });
    expect(ids(truncated)).toStrictEqual(["B", "T"]);
    expect(truncated["memberships_truncated"]).toBeUndefined();
    const password = await mint({
      method: "password",
      claims: { ...baseClaims(), ...issued, memberships: [] },
    });
    expect(ids(password)).toStrictEqual(["B", "T"]);
  });

  it("follows the active tenant on a refresh", async () => {
    await reset();
    const issued = await mint({ method: "password" });
    const moved = await mint({
      claims: {
        ...baseClaims(),
        ...issued,
        app_metadata: { active_organization: "Z" },
      },
    });
    expect(moved["tenant_id"]).toBeUndefined();
    expect(ids(moved)).toStrictEqual(["B", "T"]);
  });

  it("keeps every required claim for an OAuth client and writes no memberships", async () => {
    await reset();
    const before: Claims = { ...baseClaims(), client_id: "client-1" };
    const claims = await mint({
      method: "oauth_provider/authorization_code",
      claims: before,
    });
    for (const name of REQUIRED) {
      expect({ [name]: claims[name] }).toStrictEqual({ [name]: before[name] });
    }
    expect(claims["client_id"]).toBe("client-1");
    expect(claims["memberships"]).toStrictEqual([]);
    expect(claims["roles"]).toStrictEqual([]);
    expect(claims["authz_ver"]).toBeUndefined();
    expect(claims["tenant_id"]).toBeUndefined();
    expect(claims["user_role"]).toBeUndefined();
    expect(JSON.stringify(claims)).not.toContain("service_role");
  });

  it("does not trust a forged tenant or role in the claims of an OAuth client", async () => {
    await reset();
    const claims = await mint({
      claims: {
        ...baseClaims(),
        client_id: "client-1",
        tenant_id: "T",
        user_role: "owner",
        memberships: [{ scope: "organization", id: "T", roles: ["owner"] }],
        roles: ["owner"],
      },
    });
    expect(claims["memberships"]).toStrictEqual([]);
    expect(claims["roles"]).toStrictEqual([]);
    expect(claims["tenant_id"]).toBeUndefined();
    expect(claims["user_role"]).toBeUndefined();
  });

  it("reads memberships_for on every full sign-in and on no fast refresh", async () => {
    await reset();
    await target().admin.query(
      `insert into memberships select '${OTHER}', 'organization', 'org-' || lpad(o::text, 4, '0'), 'owner', 'staff', null, null
       from generate_series(1, 5) o`,
    );
    await target().admin.query(
      `insert into memberships select '${USER}', 'organization', 'org-' || lpad(o::text, 4, '0'), 'role-' || r, 'staff', null, null
       from generate_series(1, 5) o, generate_series(1, 1) r`,
    );
    await target().admin.query("analyze");
    const issued = await mint({ method: "password" });
    const runs = 100;
    const time = async (method: string, claims: Claims): Promise<number> => {
      const started = performance.now();
      for (let run = 0; run < runs; run += 1) {
        await mint({ method, claims });
      }
      return (performance.now() - started) / runs;
    };
    const incoming = { ...baseClaims(), ...issued };
    const readsBefore = await calls();
    const fast = await time("token_refresh", incoming);
    const fastReads = (await calls()) - readsBefore;
    const fullBefore = await calls();
    const full = await time("password", incoming);
    const fullReads = (await calls()) - fullBefore;
    process.stdout.write(
      `HOOK-REFRESH runs=${String(runs)} fast_ms=${fast.toFixed(2)} full_ms=${full.toFixed(2)} fast_memberships_for_calls=${String(fastReads)} full_memberships_for_calls=${String(fullReads)}\n`,
    );
    expect(fastReads).toBe(0);
    expect(fullReads).toBe(runs);
  }, 120_000);
});
