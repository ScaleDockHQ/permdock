import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";
import { generated } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/hook-token-shape");

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

type Claims = Record<string, unknown>;

/** The claims Supabase Auth puts in a token before the hook runs. */
function baseClaims(active: string | null): Claims {
  return {
    aud: "authenticated",
    exp: 1_900_000_000,
    iat: 1_899_996_400,
    iss: "https://abcdefghijklmnopqrst.supabase.co/auth/v1",
    sub: OWNER,
    email: "someone.with.a.long.address@example-company.com",
    phone: "",
    app_metadata: {
      provider: "email",
      providers: ["email"],
      ...(active === null ? {} : { active_organization: active }),
    },
    user_metadata: {},
    role: "authenticated",
    aal: "aal1",
    amr: [{ method: "password", timestamp: 1_899_996_400 }],
    session_id: "11111111-2222-4333-8444-555555555555",
    is_anonymous: false,
  };
}

/**
 * The length of the signed token: base64url of the header and the payload, and
 * a 64-byte signature.
 */
function tokenLength(claims: Claims): number {
  const b64 = (bytes: number): number => Math.ceil((bytes * 4) / 3);
  const header = JSON.stringify({
    alg: "ES256",
    typ: "JWT",
    kid: "k".repeat(36),
  });
  return (
    b64(Buffer.byteLength(header)) +
    1 +
    b64(Buffer.byteLength(JSON.stringify(claims))) +
    1 +
    86
  );
}

/**
 * The kept memberships of a minted token, which the hook always writes as an
 * array.
 */
function keptOf(claims: Claims): { id: string }[] {
  // SAFETY: the hook writes memberships as an array of { id, ... } objects.
  return claims["memberships"] as { id: string }[];
}

const COUNTED = [
  "roles",
  "user_role",
  "memberships",
  "team_ids",
  "attrs",
  "authz_ver",
];

describe("the token the hook mints", () => {
  let db: Postgres | undefined;
  let hookSql = "";

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
    hookSql = hook ?? "";
    db = await startPostgres([SETUP, helpers ?? "", hookSql]);
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

  const mint = async (active: string | null): Promise<Claims> => {
    const result = await target().admin.query<{ event: { claims: Claims } }>(
      "select permdock.custom_access_token_hook($1::jsonb) as event",
      [JSON.stringify({ user_id: OWNER, claims: baseClaims(active) })],
    );
    return result.rows[0]?.event.claims ?? {};
  };

  const seed = async (organizations: number, roles: number): Promise<void> => {
    const admin = target().admin;
    await admin.query("set session_replication_role = replica");
    await admin.query(`delete from memberships where user_id = '${OWNER}'`);
    await admin.query(
      `delete from permdock.user_roles where user_id = '${OWNER}'`,
    );
    await admin.query(
      `insert into memberships
         select '${OWNER}', 'organization', 'org-' || lpad(o::text, 4, '0'), 'role-' || r, 'staff', null, null, null
         from generate_series(1, ${String(organizations)}) o, generate_series(1, ${String(roles)}) r`,
    );
    await admin.query(
      `insert into organization select 'org-' || lpad(o::text, 4, '0'), null from generate_series(1, ${String(organizations)}) o on conflict do nothing`,
    );
    await admin.query(
      `insert into permdock.user_roles values ('${OWNER}', 'platform-support')`,
    );
    await admin.query("set session_replication_role = origin");
  };

  it("writes the active tenant claim even when its memberships do not fit the budget", async () => {
    await seed(20, 3);
    await target().admin.query(
      hookSql.replace("budget integer := 1024;", "budget integer := 60;"),
    );
    const claims = await mint("org-0007");
    expect(claims["memberships"]).toStrictEqual([]);
    expect(claims["memberships_truncated"]).toBe(true);
    expect(claims["tenant_id"]).toBe("org-0007");
  });

  it("counts user_role and the tenant claim in the budget at every budget", async () => {
    await seed(40, 2);
    const broken: string[] = [];
    for (const budget of Array.from({ length: 80 }, (_, n) => 150 + n * 4)) {
      await target().admin.query(
        hookSql.replace(
          "budget integer := 1024;",
          `budget integer := ${String(budget)};`,
        ),
      );
      const claims = await mint("org-0003");
      expect(claims["user_role"]).toBe("platform-support");
      const bytes = Number(
        (
          await target().admin.query<{ n: string }>(
            `select (${[...COUNTED, "tenant_id"]
              .map(
                (key) =>
                  `coalesce(octet_length(($1::jsonb -> '${key}')::text), 0)`,
              )
              .join(" + ")})::text as n`,
            [JSON.stringify(claims)],
          )
        ).rows[0]?.n,
      );
      if (bytes > budget && keptOf(claims).length > 0) {
        broken.push(`${String(budget)}: ${String(bytes)}`);
      }
    }
    expect(broken).toStrictEqual([]);
  });

  it("puts the active tenant's memberships first", async () => {
    await seed(40, 2);
    await target().admin.query(hookSql);
    const claims = await mint("org-0030");
    const first = keptOf(claims)[0];
    expect(first?.id).toBe("org-0030");
  });

  it("writes the custom-role version of the active tenant", async () => {
    await seed(3, 1);
    await target().admin.query(
      "select permdock.permdock_trusted_replace_custom_role_grants('org-0002', 'organization', null, 'role-1', array['asset.read'], array[]::text[], array[]::text[])",
    );
    const claims = await mint("org-0002");
    const version = (
      await target().admin.query<{ v: string }>(
        "select permdock.custom_roles_version_for('org-0002') as v",
      )
    ).rows[0]?.v;
    expect(claims["custom_roles_ver"]).toBe(Number(version));
    expect(Number(version)).toBeGreaterThan(0);
  });

  it("mints the token of a user with 500 memberships and 20 roles each in the time of an indexed read", async () => {
    await seed(500, 20);
    await target().admin.query("analyze");
    await target().admin.query(hookSql);
    const timings: number[] = [];
    for (let run = 0; run < 7; run += 1) {
      const started = performance.now();
      await mint("org-0001");
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    const median = timings[3] ?? Number.NaN;
    process.stdout.write(
      `HOOK-BENCH memberships=500 roles=20 rows=10000 median_ms=${median.toFixed(1)} max_ms=${(timings[6] ?? 0).toFixed(1)}\n`,
    );
    expect(median).toBeLessThan(250);
  });

  it.each(
    [1, 12, 150, 500].flatMap((organizations) =>
      [1, 5, 20].map((roles) => [organizations, roles] as const),
    ),
  )(
    "keeps the whole token under 4 KiB at %i memberships and %i roles each",
    async (organizations, roles) => {
      await seed(organizations, roles);
      await target().admin.query(hookSql);
      const claims = await mint("org-0001");
      const length = tokenLength(claims);
      process.stdout.write(
        `TOKEN-LENGTH memberships=${String(organizations)} roles=${String(roles)} chars=${String(length)} kept=${String(keptOf(claims).length)}\n`,
      );
      expect(length).toBeLessThanOrEqual(4096);
    },
    120_000,
  );
});
