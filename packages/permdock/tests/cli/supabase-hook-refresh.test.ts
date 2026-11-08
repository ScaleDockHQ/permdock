import { afterEach, describe, expect, it } from "vitest";

import { SOURCES, generate, removeHookProjects } from "./supabase-hook-kit.ts";

const PLAIN = `tableMembershipSource({ table: 'memberships' }),
    junctionMembershipSource({
      table: 'customer_contacts',
      scope: 'customer',
      within: { organization: 'organization_id' },
      roles: ['contact'],
      via: 'contact',
    }),`;

const FAST = "if event ->> 'authentication_method' = 'token_refresh'";
const SLIM = "if coalesce(claims ->> 'client_id', '') <> '' then";

describe("supabase hook refresh and oauth branches", () => {
  afterEach(removeHookProjects);

  it("compiles the refresh fast path for sources whose changes all bump authz_ver", async () => {
    const { code, sql } = await generate(`{ memberships: [${PLAIN}] }`);
    expect(code).toBe(0);
    expect(sql).toContain(FAST);
    expect(sql).toContain(
      "jsonb_typeof(event -> 'claims' -> 'authz_ver') = 'number'",
    );
    expect(sql).toContain(
      "and not (event -> 'claims' ? 'memberships_truncated')",
    );
    expect(sql).toContain(
      "if (event -> 'claims' ->> 'authz_ver')::numeric = ver then",
    );
    expect(sql).toContain("fast boolean := false;");
    expect(sql).toContain("  if fast then");
    expect(sql).not.toContain(SLIM);
  });

  it("reads the version, the memberships and the roles in the full branch only", async () => {
    const { sql } = await generate(`{ memberships: [${PLAIN}] }`);
    const fast = sql.indexOf("  if fast then");
    const full = sql.indexOf("  else\n", fast);
    expect(sql.slice(fast, full)).not.toContain("memberships_for");
    expect(sql.slice(full)).toContain(".memberships_for(uid)");
  });

  it("drops the previous tenant claim before the active tenant is read again", async () => {
    const { sql } = await generate(`{ memberships: [${PLAIN}] }`);
    expect(sql).toContain(
      "claims := claims - 'attrs' - 'user_role' - 'tenant_id';",
    );
  });

  it("never compiles the fast path for a source with expiresAt", async () => {
    const { code, sql } = await generate(`{ memberships: [${SOURCES}] }`);
    expect(code).toBe(0);
    expect(sql).not.toContain(FAST);
    expect(sql).not.toContain("fast boolean");
  });

  it("never compiles the fast path for a source that reads a suspension table", async () => {
    const { code, sql } = await generate(
      `{ memberships: [${PLAIN}] }`,
      [],
      "{}",
    );
    expect(code).toBe(0);
    const suspended = await generate(
      `{ memberships: [tableMembershipSource({ table: 'memberships', suspension: { scopes: { organization: { table: 'organization', id: 'id', disabledAt: 'disabled_at' } } } })] }`,
    );
    expect(suspended.code).toBe(0);
    expect(suspended.sql).not.toContain(FAST);
    expect(sql).toContain(FAST);
  });

  it("never compiles the fast path without authz_ver", async () => {
    const { code, sql } = await generate(
      `{ memberships: [${PLAIN}], version: false }`,
    );
    expect(code).toBe(0);
    expect(sql).not.toContain(FAST);
  });

  it("refuses an explicit refresh 'reuse' that cannot hold", async () => {
    const { code, output } = await generate(
      `{ memberships: [${SOURCES}], refresh: 'reuse' }`,
    );
    expect(code).not.toBe(0);
    expect(output).toContain("supabase.hook.refresh 'reuse' cannot run");
    expect(output).toContain("expiresAt");
  });

  it("compiles no fast path with refresh 'full'", async () => {
    const { sql } = await generate(
      `{ memberships: [${PLAIN}], refresh: 'full' }`,
    );
    expect(sql).not.toContain(FAST);
  });

  it("refuses an unknown refresh or oauth value", async () => {
    const refresh = await generate(
      `{ memberships: [${PLAIN}], refresh: 'cached' }`,
    );
    expect(refresh.output).toContain("supabase.hook.refresh must be");
    const oauth = await generate(`{ memberships: [${PLAIN}], oauth: 'none' }`);
    expect(oauth.output).toContain("supabase.hook.oauth must be");
  });

  it("emits the full claim shape for an OAuth client by default", async () => {
    const { sql } = await generate(`{ memberships: [${PLAIN}] }`);
    expect(sql).not.toContain("client_id");
  });

  it("returns empty roles and memberships for an OAuth client with oauth 'slim'", async () => {
    const { code, sql } = await generate(
      `{ memberships: [${PLAIN}], oauth: 'slim' }`,
    );
    expect(code).toBe(0);
    expect(sql).toContain(SLIM);
    const slim = sql.slice(
      sql.indexOf(SLIM),
      sql.indexOf("end if;", sql.indexOf(SLIM)),
    );
    expect(slim).toContain(
      "jsonb_build_object('roles', '[]'::jsonb, 'memberships', '[]'::jsonb)",
    );
    expect(slim).toContain("return jsonb_set(event, '{claims}', claims);");
    expect(slim).not.toContain("memberships_for");
    expect(slim).not.toContain("service_role");
    for (const required of [
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
    ]) {
      expect(slim).not.toContain(`- '${required}'`);
    }
  });

  it("reuses the team ids and refuses a truncated team claim", async () => {
    const { code, sql } = await generate(
      `{ memberships: [${PLAIN}], teams: { table: 'team_members', user: 'user_id', team: 'team_id' } }`,
    );
    expect(code).toBe(0);
    expect(sql).toContain("and not (event -> 'claims' ? 'team_ids_truncated')");
    expect(sql).toContain(
      "team_ids := case when jsonb_typeof(event -> 'claims' -> 'team_ids') = 'array'",
    );
    expect(sql).toContain("octet_length(team_ids::text)");
  });

  it("counts the custom-role version in the reused budget", async () => {
    const { code, sql } = await generate(
      `{ memberships: [${PLAIN}] }`,
      [],
      "{ dialect: 'supabase', authorize: 'database', scopeTypes: { tenant: 'text' }, customRoles: true }",
    );
    expect(code).toBe(0);
    expect(sql).toContain(FAST);
    expect(sql).toContain("octet_length(ver::text) + 20 + 2 <= budget");
  });

  it("drops the OAuth client's teams, custom-role version and hook.claims with oauth 'slim'", async () => {
    const { code, sql } = await generate(
      `{ memberships: [${PLAIN}], oauth: 'slim', claims: { features: 'public.feature_claims' }, teams: { table: 'team_members', user: 'user_id', team: 'team_id' } }`,
      [],
      "{ dialect: 'supabase', authorize: 'database', scopeTypes: { tenant: 'text' }, customRoles: true }",
    );
    expect(code).toBe(0);
    const slim = sql.slice(
      sql.indexOf(SLIM),
      sql.indexOf("end if;", sql.indexOf(SLIM)),
    );
    expect(slim).toContain("- 'team_ids' - 'team_ids_truncated'");
    expect(slim).toContain("- 'custom_roles_ver'");
    expect(slim).toContain("- 'features'");
  });
});
