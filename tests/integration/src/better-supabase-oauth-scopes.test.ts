import { PGlite } from "@electric-sql/pglite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizationProvider } from "permdock/better-supabase";
import { run } from "permdock/cli";
import { supabaseHookManifestFixture } from "permdock/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { permissionsBlockSql } from "./support/better-supabase-sql.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/oauth-scopes");

const OWNER = "00000000-0000-4000-8000-0000000000e1";
const ORG = "00000000-0000-4000-8000-0000000000f1";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role service_role nologin;
create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
insert into auth.users (id) values ('${OWNER}');
`;

describe("policy oauthScopes in better-supabase's SQL delegation cap", () => {
  let lite: PGlite | undefined;
  let scopes: Readonly<Record<string, readonly string[]>> = {};

  beforeAll(async () => {
    const exported = await run(["catalog"], { cwd: FIXTURE });
    if (exported.code !== 0) {
      throw new Error(`catalog: ${exported.stdout}`);
    }
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
      catalog: exported.stdout,
    });
    scopes = provider.delegation?.scopes ?? {};
    lite = new PGlite();
    await lite.exec(SETUP);
    for (const contents of permissionsBlockSql({ delegationScopes: scopes })) {
      await lite.exec(contents);
    }
    await lite.exec(
      `insert into better_supabase.memberships (organization_id, user_id, role) values ('${ORG}', '${OWNER}', 'owner');`,
    );
  }, 120_000);

  afterAll(async () => {
    await lite?.close();
  });

  const memberCan = async (
    claims: Readonly<Record<string, unknown>>,
    permission: string,
  ): Promise<unknown> => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    await lite.exec("begin;");
    try {
      await lite.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: OWNER, role: "authenticated", ...claims }),
      ]);
      const result = await lite.query<{ readonly ok: unknown }>(
        "select better_supabase.member_can($1::uuid, $2::uuid, $3) as ok",
        [OWNER, ORG, permission],
      );
      return result.rows[0]?.ok;
    } finally {
      await lite.exec("rollback");
    }
  };

  it("hands the provider the coarse scopes next to the per-permission ones", () => {
    expect(scopes).toStrictEqual({
      "mcp:read": ["task.read"],
      "mcp:write": ["task.read", "task.update"],
      "task:read": ["task.read"],
      "task:update": ["task.update"],
    });
  });

  it("lets an mcp:read token read and refuses it an update", async () => {
    const token = { client_id: "mcp-client", scope: "openid mcp:read" };
    expect({
      read: await memberCan(token, "task.read"),
      update: await memberCan(token, "task.update"),
      writeRead: await memberCan(
        { ...token, scope: "mcp:write" },
        "task.update",
      ),
      unscoped: await memberCan({ ...token, scope: "openid" }, "task.read"),
      user: await memberCan({}, "task.update"),
    }).toStrictEqual({
      read: true,
      update: false,
      writeRead: true,
      unscoped: false,
      user: true,
    });
  });

  it("caps an automation run to the keys authorizationHooks writes", async () => {
    const capped = {
      bs_permission_cap: ["task.read"],
      bsb_permission_cap: ["task.read"],
    };
    expect({
      read: await memberCan(capped, "task.read"),
      update: await memberCan(capped, "task.update"),
    }).toStrictEqual({ read: true, update: false });
  });
});
