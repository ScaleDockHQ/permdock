import type { SupabaseRpcClient } from "permdock/supabase";

import { defineMiddleware, pipeline } from "@supabase/middleware";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definePermDock } from "permdock/supabase";
import { createPermDock } from "permdock/supabase/middleware";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { permissions, policy } from "../fixtures/named-scopes/policy.ts";
import { startPostgres } from "./support/postgres.ts";
import { generated } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/subject-for");

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

describe("definePermDock and the middleware against Postgres", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    db = await startPostgres([
      SETUP,
      ...(await generated(
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
      )),
      `insert into permdock.user_roles values ('${OWNER}', 'platform-support');
select permdock.permdock_trusted_replace_custom_role_grants('B', 'organization', null, 'mechanic', array['asset.read'], array[]::text[], array[]::text[]);`,
    ]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  /**
   * A supabase-js shaped client over the superuser connection, as a
   * `service_role` client would call it.
   */
  const client = (): SupabaseRpcClient => ({
    schema(name) {
      return {
        async rpc(fn, args) {
          if (db === undefined) {
            throw new Error("PermDock: Postgres was not started");
          }
          try {
            const result =
              fn === "members_of"
                ? await db.admin.query<{ data: unknown }>(
                    `select "${name}"."${fn}"($1, $2) as data`,
                    [args["p_scope"], args["p_id"]],
                  )
                : await db.admin.query<{ data: unknown }>(
                    `select "${name}"."${fn}"($1::uuid) as data`,
                    [args["p_user"]],
                  );
            return { data: result.rows[0]?.data ?? null, error: null };
          } catch (error) {
            return { data: null, error: { message: String(error) } };
          }
        },
      };
    },
  });

  const asset = { id: "a", organization_id: "B", customer_id: "c" };

  it("reads memberships and custom roles through the default sources", async () => {
    const app = definePermDock(policy, { client });
    const owner = await app.fromClaims({ sub: OWNER, role: "authenticated" });
    expect(owner.tenant("B").can(permissions.asset.read, asset)).toBe(true);
    expect(owner.tenant("B").can(permissions.asset.update, asset)).toBe(false);
    const suspended = await app.fromClaims({
      sub: SUSPENDED,
      role: "authenticated",
    });
    expect(
      suspended
        .tenant("T")
        .can(permissions.asset.read, { ...asset, organization_id: "T" }),
    ).toBe(false);
  });

  it("rereads memberships when the token's authz_ver is stale", async () => {
    const app = definePermDock(policy, { client });
    const fresh = await app.fromClaims({
      sub: OWNER,
      role: "authenticated",
      authz_ver: 0,
    });
    expect(fresh.tenant("B").can(permissions.asset.read, asset)).toBe(true);
  });

  it("builds the instance for a request in the middleware pipeline", async () => {
    const app = definePermDock(policy, { client });
    const { withPermDock } = createPermDock(app);
    const claims = { sub: OWNER, role: "authenticated" };
    const withClaims = defineMiddleware<
      "jwtClaims",
      undefined,
      Record<never, never>,
      typeof claims
    >({ key: "jwtClaims", run: () => async () => ({ jwtClaims: claims }) });
    const handler = pipeline(
      [withClaims(), withPermDock()],
      async (_request, ctx) =>
        Response.json({
          read: ctx.permdock.tenant("B").can(permissions.asset.read, asset),
          update: ctx.permdock.tenant("B").can(permissions.asset.update, asset),
        }),
    );
    const response = await handler(
      new Request("http://localhost/assets/a"),
      {},
    );
    expect(await response.json()).toStrictEqual({ read: true, update: false });
  });
});
