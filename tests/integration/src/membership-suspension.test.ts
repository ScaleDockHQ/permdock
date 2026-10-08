import type { Permission, Principal, WhereResult } from "permdock";

import { PGlite } from "@electric-sql/pglite";
import { pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermDock } from "permdock";
import { run } from "permdock/cli";
import { toWhere } from "permdock/drizzle";
import {
  type SqlQuery,
  type SupabaseSuspension,
  subjectFromSupabase,
} from "permdock/supabase";
import { type OrmParityScenario, ormParity } from "permdock/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  sources,
  suspension,
} from "../fixtures/named-scopes/disabled/permdock.config.ts";
import {
  assets,
  documents,
  permissions,
  policy,
} from "../fixtures/named-scopes/policy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/named-scopes/disabled");

const OWNER = "00000000-0000-4000-8000-000000000001";
const STAFF = "00000000-0000-4000-8000-000000000002";
const PRIVATE = "00000000-0000-4000-8000-000000000003";
const VIEWER = "00000000-0000-4000-8000-000000000004";
const USERS = [OWNER, STAFF, PRIVATE, VIEWER];

const values = (rows: readonly Record<string, string>[], keys: string[]) =>
  rows
    .map((row) => `(${keys.map((key) => `'${row[key] ?? ""}'`).join(", ")})`)
    .join(", ");

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
grant select on auth.users to supabase_auth_admin;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon, supabase_auth_admin;
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ${USERS.map((id) => `('${id}')`).join(", ")};
create table organization_users (
  organization_id text not null, user_id uuid not null, role text not null, via text,
  disabled_at timestamptz
);
create table customer_contacts (
  customer_id text not null, organization_id text not null, user_id uuid not null, role text not null,
  via text, disabled_at timestamptz
);
insert into organization_users values
  ('T', '${OWNER}', 'owner', 'staff', null), ('B', '${OWNER}', 'owner', 'staff', now()),
  ('T', '${STAFF}', 'member', 'staff', now()), ('B', '${VIEWER}', 'viewer', 'staff', null);
insert into customer_contacts values
  ('A', 'T', '${PRIVATE}', 'contact', 'contact', now()), ('C', 'B', '${STAFF}', 'contact', 'contact', null);
create table organization (id text primary key);
create table quote (id text primary key, organization_id text not null, customer_id text not null, status text not null);
create table invoice (id text primary key, organization_id text not null, customer_id text not null, status text not null);
create table asset (id text primary key, organization_id text not null, customer_id text not null);
insert into quote values ${values(documents, ["id", "organization_id", "customer_id", "status"])};
insert into invoice values ${values(documents, ["id", "organization_id", "customer_id", "status"])};
insert into asset values ${values(assets, ["id", "organization_id", "customer_id"])};
grant select, insert, update, delete on quote, invoice, asset to authenticated;
`;

const tables = {
  quote: pgTable("quote", {
    id: text("id"),
    organization_id: text("organization_id"),
    customer_id: text("customer_id"),
    status: text("status"),
  }),
  invoice: pgTable("invoice", {
    id: text("id"),
    organization_id: text("organization_id"),
    customer_id: text("customer_id"),
    status: text("status"),
  }),
  asset: pgTable("asset", {
    id: text("id"),
    organization_id: text("organization_id"),
    customer_id: text("customer_id"),
  }),
} as const;

type Table = keyof typeof tables;

const checks: readonly (readonly [
  Permission<string, unknown, "instance">,
  Table,
])[] = [
  [permissions.quote.read, "quote"],
  [permissions.invoice.read, "invoice"],
  [permissions.asset.read, "asset"],
];

type Claims = Record<string, unknown>;

function tableOf(permission: { readonly key: string }): Table {
  const found = checks.find(([checked]) => checked.key === permission.key);
  if (found === undefined) {
    throw new Error(`PermDock: no table for ${permission.key}`);
  }
  return found[1];
}

async function generate(cwd: string): Promise<readonly string[]> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-disabled-"));
  const out = join(dir, "rls.sql");
  const hookOut = join(dir, "hook.sql");
  const rls = await run(
    ["rls", "generate", "--target", "sql", "--rbac", "supabase", "--out", out],
    { cwd },
  );
  if (rls.code !== 0) {
    throw new Error(`rls generate: ${rls.stdout}${rls.stderr}`);
  }
  const hook = await run(["supabase", "hook", "generate", "--out", hookOut], {
    cwd,
  });
  if (hook.code !== 0) {
    throw new Error(`hook generate: ${hook.stdout}${hook.stderr}`);
  }
  const sql = [readFileSync(out, "utf8"), readFileSync(hookOut, "utf8")];
  rmSync(dir, { recursive: true, force: true });
  return sql;
}

describe.each([
  { mode: "jwt", cwd: FIXTURE, keep: suspension },
  { mode: "database", cwd: join(FIXTURE, "database"), keep: suspension },
  {
    mode: "database over sources",
    cwd: join(FIXTURE, "sources-keep"),
    keep: suspension,
  },
  {
    mode: "database over sources, without keep",
    cwd: join(FIXTURE, "sources"),
    keep: undefined,
  },
])("membership suspension ($mode)", ({ mode, cwd, keep }) => {
  let lite: PGlite | undefined;

  beforeAll(async () => {
    lite = new PGlite();
    await lite.exec(SETUP);
    for (const sql of await generate(cwd)) {
      await lite.exec(sql);
    }
  });

  afterAll(async () => {
    await lite?.close();
  });

  const database = (): PGlite => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    return lite;
  };

  async function as<T>(
    role: "authenticated" | "supabase_auth_admin",
    claims: Claims,
    work: (db: PGlite) => Promise<T>,
  ): Promise<T> {
    const db = database();
    await db.exec(`begin; set local role ${role};`);
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(claims),
      ]);
      return await work(db);
    } finally {
      await db.exec("rollback");
    }
  }

  async function mint(user: string): Promise<Claims> {
    const event = JSON.stringify({
      user_id: user,
      claims: { sub: user, role: "authenticated", aal: "aal1" },
    });
    return as(
      "supabase_auth_admin",
      { role: "supabase_auth_admin" },
      async (db) => {
        const result = await db.query<{ event: { claims: Claims } }>(
          "select permdock.custom_access_token_hook($1::jsonb) as event",
          [event],
        );
        const claims = result.rows[0]?.event.claims;
        if (claims === undefined) {
          throw new Error("PermDock: the hook returned no claims");
        }
        return claims;
      },
    );
  }

  async function select(
    name: Table,
    where: WhereResult,
  ): Promise<readonly (string | null)[]> {
    const db = drizzle({ client: database() });
    switch (name) {
      case "quote":
        return (
          await db
            .select({ id: tables.quote.id })
            .from(tables.quote)
            .where(toWhere(where, tables.quote))
        ).map((row) => row.id);
      case "invoice":
        return (
          await db
            .select({ id: tables.invoice.id })
            .from(tables.invoice)
            .where(toWhere(where, tables.invoice))
        ).map((row) => row.id);
      case "asset":
        return (
          await db
            .select({ id: tables.asset.id })
            .from(tables.asset)
            .where(toWhere(where, tables.asset))
        ).map((row) => row.id);
      default: {
        const exhaustive: never = name;
        return exhaustive;
      }
    }
  }

  const query: SqlQuery = (statement, params) =>
    database().query(statement, [...params]);

  const live = (options: { readonly suspension?: SupabaseSuspension }) =>
    sources({ ...options, query });

  async function claimsFor(user: string, tenant: string): Promise<Claims> {
    return mode === "jwt"
      ? { ...(await mint(user)), tenant_id: tenant }
      : {
          sub: user,
          role: "authenticated",
          aal: "aal1",
          tenant_id: tenant,
        };
  }

  async function rlsRows(claims: Claims, table: Table): Promise<string[]> {
    return as("authenticated", claims, async (db) =>
      (await db.query<{ id: string }>(`select id from public.${table}`)).rows
        .map((row) => row.id)
        .toSorted(),
    );
  }

  it("keeps the disabled membership and its role in the table", async () => {
    const rows = await database().query<{ count: number }>(
      "select count(*)::int as count from organization_users where user_id = $1 and role = 'owner'",
      [OWNER],
    );
    expect(rows.rows[0]?.count).toBe(2);
  });

  it("reads a disabled membership as kept or absent in process", async () => {
    const permdock = await createPermDock(
      policy,
      { id: OWNER, kind: "user" },
      {
        tenant: "B",
        memberships: live(keep === undefined ? {} : { suspension: keep }),
      },
    );
    const inB = permdock.subject.principal?.memberships?.filter(
      (membership) => membership.id === "B",
    );
    expect(inB).toEqual(
      keep === undefined
        ? []
        : [
            {
              scope: "organization",
              id: "B",
              roles: ["owner"],
              via: "staff",
              keep: ["asset.read"],
            },
          ],
    );
    const sent = documents.find((row) => row.id === "d_c_sent");
    const asset = assets.find((row) => row.id === "a_c_sent");
    expect(permdock.can(permissions.asset.read, asset)).toBe(
      keep !== undefined,
    );
    expect(permdock.can(permissions.asset.update, asset)).toBe(false);
    expect(permdock.can(permissions.invoice.read, sent)).toBe(false);
  });

  it("agrees in process, through where() and in RLS, for every user and tenant", async () => {
    const scenarios: OrmParityScenario<Principal>[] = [];
    const rlsFailures: unknown[] = [];
    for (const user of USERS) {
      for (const tenant of ["T", "B"]) {
        const options = {
          tenant,
          memberships: live(keep === undefined ? {} : { suspension: keep }),
        };
        const permdock = await createPermDock(
          policy,
          { id: user, kind: "user" },
          options,
        );
        const claims = await claimsFor(user, tenant);
        if (mode === "jwt") {
          const fromClaims = await createPermDock(
            policy,
            subjectFromSupabase(claims, { memberships: "memberships" })
              .principal,
          );
          expect(
            fromClaims.subject.principal?.memberships?.toSorted((a, b) =>
              `${a.scope}:${a.id}`.localeCompare(`${b.scope}:${b.id}`),
            ),
          ).toEqual(
            permdock.subject.principal?.memberships?.toSorted((a, b) =>
              `${a.scope}:${a.id}`.localeCompare(`${b.scope}:${b.id}`),
            ),
          );
        }
        for (const [permission, table] of checks) {
          const rows = table === "asset" ? assets : documents;
          const expected = permdock
            .filter(permission, rows)
            .map((row) => row.id)
            .toSorted();
          const actual = await rlsRows(claims, table);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            rlsFailures.push({ user, tenant, table, actual, expected });
          }
          scenarios.push({
            name: `${user} ${tenant} ${table}`,
            user: { id: user, kind: "user" },
            options,
            permission,
            rows,
          });
        }
      }
    }
    expect(rlsFailures).toEqual([]);
    const report = await ormParity(policy, scenarios, {
      run: async ({ scenario, where }) =>
        select(tableOf(scenario.permission), where),
    });
    expect(
      report.results
        .filter((result) => !result.ok)
        .map((result) => result.name),
    ).toEqual([]);
  });

  it("drops a disabled membership's permissions in RLS but for keep", async () => {
    const kept = (ids: readonly string[]) => (keep === undefined ? [] : ids);
    expect(await rlsRows(await claimsFor(OWNER, "B"), "asset")).toEqual(
      kept(["a_b_draft", "a_c_sent"]),
    );
    expect(await rlsRows(await claimsFor(OWNER, "B"), "invoice")).toEqual([]);
    expect(await rlsRows(await claimsFor(OWNER, "T"), "quote")).toHaveLength(4);
    expect(await rlsRows(await claimsFor(STAFF, "T"), "quote")).toEqual([]);
    expect(await rlsRows(await claimsFor(STAFF, "T"), "asset")).toEqual(
      kept(["a_a_accepted", "a_a_draft", "a_a_sent", "a_g_sent"]),
    );
    expect(await rlsRows(await claimsFor(PRIVATE, "T"), "invoice")).toEqual([]);
    expect(await rlsRows(await claimsFor(PRIVATE, "T"), "asset")).toEqual(
      kept(["a_a_accepted", "a_a_draft", "a_a_sent"]),
    );
  });

  it("leaves a disabled membership out of member_<scope>_ids", async () => {
    const ids = await as(
      "authenticated",
      await claimsFor(OWNER, "B"),
      async (db) =>
        (
          await db.query<{ id: string }>(
            "select id::text from permdock.member_organization_ids() id",
          )
        ).rows.map((row) => row.id),
    );
    expect(ids).toEqual(["T"]);
  });

  it("refuses to disable the last live owner", async () => {
    await expect(
      database().query(
        "update organization_users set disabled_at = now() where user_id = $1 and organization_id = 'T'",
        [OWNER],
      ),
    ).rejects.toThrow(/keeps at least 1 owner/u);
    await database().query(
      "insert into organization_users values ('T', $1, 'owner', 'staff', null)",
      [VIEWER],
    );
    await database().query(
      "update organization_users set disabled_at = now() where user_id = $1 and organization_id = 'T'",
      [OWNER],
    );
    await database().query(
      "update organization_users set disabled_at = null where user_id = $1 and organization_id = 'T'",
      [OWNER],
    );
    await database().query(
      "delete from organization_users where user_id = $1 and organization_id = 'T'",
      [VIEWER],
    );
  });

  it("answers authorize() for a kept permission of a disabled membership only", async () => {
    const authorize = async (
      permission: string,
      user: string,
      tenant: string,
    ) =>
      as(
        "authenticated",
        await claimsFor(user, tenant),
        async (db) =>
          (
            await db.query<{ ok: boolean }>(
              "select permdock.authorize($1::permdock.app_permission, $2) as ok",
              [permission, tenant],
            )
          ).rows[0]?.ok,
      );
    const mapped = keep !== undefined && !mode.includes("sources");
    expect(await authorize("asset.read", OWNER, "B")).toBe(mapped);
    expect(await authorize("asset.update", OWNER, "B")).toBe(false);
    expect(await authorize("asset.update", OWNER, "T")).toBe(mapped);
    expect(await authorize("asset.update", STAFF, "T")).toBe(false);
    expect(await authorize("asset.read", STAFF, "T")).toBe(mapped);
  });
});
