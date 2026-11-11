import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/interactive-only");

const OWNER = "00000000-0000-4000-8000-0000000000c1";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${OWNER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values ('acme', '${OWNER}', 'owner');
create table public.doc (id text primary key, "orgId" text not null, "ownerId" uuid);
insert into public.doc values ('d1', 'acme', '${OWNER}');

create function public.two_sessions(p_first jsonb, p_second jsonb, p_grant text)
returns table (first text[], second text[])
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', p_first::text, true);
  first := array(select permdock.permitted_tenant_ids(p_grant));
  perform set_config('request.jwt.claims', p_second::text, true);
  second := array(select permdock.permitted_tenant_ids(p_grant));
  return next;
end;
$$;
`;

const USER = { sub: OWNER, role: "authenticated", session_id: "s1" };

const CREDENTIALS = {
  apiKey: {
    ...USER,
    api_key: {
      id: "k1",
      scopes: [
        "organization.read",
        "organization.update",
        "organization.transferOwnership",
        "doc.read",
        "doc.purge",
      ],
    },
  },
  oauthClient: {
    ...USER,
    client_id: "mcp-client",
    scope: "organization:transferOwnership organization:read doc:purge",
  },
  agent: { ...USER, act: { sub: "agent-1" } },
  support: { ...USER, act: { sub: "staff-1", kind: "support" } },
} as const;

describe("interactive-only permissions in the SQL helpers", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-interactive-"));
  let lite: PGlite | undefined;
  let sql = "";

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await rlsGenerate(["--target", "sql", "--out", out], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    sql = readFileSync(out, "utf8");
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(sql);
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  const as = async <T>(
    claims: Readonly<Record<string, unknown>>,
    query: string,
    params: readonly unknown[] = [],
  ): Promise<T | undefined> => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    await lite.exec("begin");
    try {
      await lite.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(claims),
      ]);
      const result = await lite.query<{ readonly v: T }>(query, [...params]);
      return result.rows[0]?.v;
    } finally {
      await lite.exec("rollback");
    }
  };

  const checks = async (
    claims: Readonly<Record<string, unknown>>,
    key: string,
  ): Promise<Record<string, unknown>> => ({
    has: await as(claims, "select permdock.permdock_has_permission($1) as v", [
      key,
    ]),
    ids: await as(
      claims,
      "select array(select permdock.permitted_tenant_ids_by_permission($1)) as v",
      [key],
    ),
    grantIds: await as(
      claims,
      "select array(select permdock.permitted_tenant_ids($1)) as v",
      [key],
    ),
  });

  it("keeps the interactive-only keys out of the token scope map", () => {
    expect(sql).toContain("permdock_interactive_allows(p_grant text)");
    expect(sql).not.toMatch(/"organization:transferOwnership":\[/u);
    expect(sql).not.toMatch(/"doc:purge":\[/u);
  });

  it("lets the user's own session use an interactive-only permission", async () => {
    expect(await checks(USER, "organization.transferOwnership")).toStrictEqual({
      has: false,
      ids: ["acme"],
      grantIds: ["acme"],
    });
    expect(
      await as(USER, "select permdock.can_doc('d1'::text, 'doc.purge') as v"),
    ).toBe(true);
  });

  for (const [name, claims] of Object.entries(CREDENTIALS)) {
    it(`refuses an interactive-only permission to ${name}`, async () => {
      expect(
        await checks(claims, "organization.transferOwnership"),
      ).toStrictEqual({ has: false, ids: [], grantIds: [] });
      expect(
        await as(
          claims,
          "select permdock.can_doc('d1'::text, 'doc.purge') as v",
        ),
      ).toBe(false);
      expect(
        await as(
          claims,
          "select permdock.permdock_can_assign('owner', 'acme') as v",
        ),
      ).toBe(false);
    });
  }

  it("keeps normal permissions working for an API key and an OAuth client", async () => {
    expect(
      await as(
        CREDENTIALS.apiKey,
        "select array(select permdock.permitted_tenant_ids('organization.update')) as v",
      ),
    ).toStrictEqual(["acme"]);
    expect(
      await as(
        CREDENTIALS.oauthClient,
        "select array(select permdock.permitted_tenant_ids('organization.read')) as v",
      ),
    ).toStrictEqual(["acme"]);
    expect(
      await as(
        CREDENTIALS.apiKey,
        "select permdock.can_doc('d1'::text, 'doc.read') as v",
      ),
    ).toBe(true);
    expect(
      await as(
        CREDENTIALS.apiKey,
        "select permdock.permdock_can_assign('member', 'acme') as v",
      ),
    ).toBe(true);
    expect(
      await as(
        USER,
        "select permdock.permdock_can_assign('owner', 'acme') as v",
      ),
    ).toBe(true);
  });

  it("never answers a delegated token from the user's memo in the same statement", async () => {
    const result = await as<unknown>(
      USER,
      "select jsonb_build_array(s.first, s.second) as v from public.two_sessions($1::jsonb, $2::jsonb, $3) s",
      [
        JSON.stringify(USER),
        JSON.stringify(CREDENTIALS.agent),
        "organization.transferOwnership",
      ],
    );
    expect(result).toStrictEqual([["acme"], []]);
  });
});
