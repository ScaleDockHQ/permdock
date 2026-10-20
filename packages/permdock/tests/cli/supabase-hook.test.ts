import { afterEach, describe, expect, it } from "vitest";

import type { SupabaseHookManifest } from "../../src/supabase/manifest.ts";

import { run } from "../../src/cli/core/run.ts";
import { jsonData } from "./envelope.ts";
import { SOURCES, generate, removeHookProjects } from "./supabase-hook-kit.ts";

afterEach(removeHookProjects);

describe("permdock supabase hook generate", () => {
  it("emits the hook, the grants, the version table and the config.toml block", async () => {
    const { code, output, sql } = await generate(
      `{ memberships: [${SOURCES}], attrs: { table: 'profiles', columns: ['locale', 'timezone', 'app_metadata.plan'] } }`,
    );
    expect(code).toBe(0);
    expect(output).toContain("jwt_expiry = 900");
    expect(output).toContain(
      'uri = "pg-functions://postgres/permdock/custom_access_token_hook"',
    );
    expect(sql).toContain(
      'create schema if not exists "permdock";\nrevoke all on schema "permdock" from public;\n\ncreate or replace function "permdock".custom_access_token_hook(event jsonb)',
    );
    expect(sql).toContain(`claims -> 'app_metadata' ->> 'active_organization'`);
    expect(sql).toContain("budget integer := 1024;");
    expect(sql).toContain(
      `claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);`,
    );
    expect(sql).toContain(
      `claims := jsonb_set(claims, '{tenant_id}', to_jsonb(active));`,
    );
    expect(sql).toContain(`'locale', to_jsonb(p."locale")`);
    expect(sql).toContain(`'plan', claims -> 'app_metadata' -> 'plan'`);
    expect(sql).toContain(
      `where has_column_privilege(r.role, '"public"."profiles"', c.name, 'INSERT')`,
    );
    expect(sql).toContain("+ used > budget");
    expect(sql).not.toMatch(/user_meta/iu);
    expect(sql).toContain(`from "public"."customer_contacts" m`);
    expect(sql).toContain(`jsonb_build_array('contact')`);
    expect(sql).toContain(
      'create table if not exists "permdock"."permdock_authz_version"',
    );
    expect(sql).toContain('create trigger "permdock_authz_version"');
    expect(sql).toContain('create trigger "permdock_protect_managed"');
    expect(sql).toContain(
      'revoke execute on function "permdock".custom_access_token_hook(jsonb) from authenticated, anon, public;',
    );
    for (const table of [
      '"public"."memberships"',
      '"public"."customer_contacts"',
      '"permdock"."user_roles"',
      '"public"."profiles"',
    ]) {
      expect(sql).toContain(
        `grant select on table ${table} to supabase_auth_admin;`,
      );
    }
    expect(sql).toContain(
      'create or replace function "permdock".permdock_bump_authz_version_for(p_users uuid[])',
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_bump_authz_version_for(uuid[]) from public, anon, authenticated;',
    );
    expect(sql).toContain(
      "where u is not null and exists (select 1 from auth.users au where au.id = u)",
    );
    expect(sql).not.toMatch(/grant execute on function [^;]*_for\(uuid\[\]\)/u);
    expect(sql).not.toMatch(/service_role/iu);
  });

  it("takes --active-from, --budget and --check", async () => {
    const { code, sql } = await generate(
      `{ memberships: [${SOURCES}], version: false }`,
      ["--active-from", "profiles.active_org", "--budget", "2048"],
    );
    expect(code).toBe(0);
    expect(sql).toContain(
      `(select a."active_org"::text from "public"."profiles" a where a."id" = v_active_user)`,
    );
    expect(sql).toContain(
      `v_active_user "public"."profiles"."id"%type := uid;`,
    );
    expect(sql).toContain("budget integer := 2048;");
    expect(sql).not.toContain("permdock_authz_version");
    const meta = await generate(`{ memberships: [${SOURCES}] }`, [
      "--active-from",
      "app_metadata.org",
    ]);
    expect(meta.sql).toContain(`claims -> 'app_metadata' ->> 'org'`);
  });

  it("reports a missing hook file under --check", async () => {
    const missing = await generate(`{ memberships: [${SOURCES}] }`, [
      "--check",
    ]);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("supabase hook drift: missing");
  });

  it("refuses configurations it cannot compile", async () => {
    expect((await generate("undefined")).code).toBe(2);
    expect((await generate("{ memberships: [] }")).output).toContain(
      "at least one",
    );
    const orphan = await generate(
      `{ memberships: [junctionMembershipSource({ table: 'customer_contacts', scope: 'customer', roles: ['contact'] })] }`,
    );
    expect(orphan.code).toBe(2);
    expect(orphan.output).toContain("within columns for organization");
    const undeclared = await generate(
      `{ memberships: [junctionMembershipSource({ table: 't', scope: 'site', roles: ['x'] })] }`,
    );
    expect(undeclared.output).toContain("scope 'site'");
    expect(
      (await generate(`{ memberships: [${SOURCES}] }`, ["--budget", "0"])).code,
    ).toBe(2);
    expect(
      (
        await generate(`{ memberships: [${SOURCES}] }`, [
          "--active-from",
          "nodot",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await generate(
          `{ memberships: [tableMembershipSource({ table: 'x; drop' })] }`,
        )
      ).code,
    ).toBe(2);
  });

  it("refuses attrs that are not server-owned", async () => {
    const attrs = async (value: string) =>
      generate(`{ memberships: [${SOURCES}], attrs: ${value} }`);
    for (const [value, message] of [
      [`{ table: 'profiles', columns: ['user_metadata'] }`, "user-editable"],
      [
        `{ table: 'profiles', columns: ['raw_user_meta_data'] }`,
        "user-editable",
      ],
      [`{ columns: ['user_metadata.region'] }`, "user-editable"],
      [`{ table: 'auth.users', columns: ['email'] }`, "auth.users"],
      [`{ table: 'profiles', columns: ['__proto__'] }`, "prototype key"],
      [
        `{ table: 'profiles', columns: ['region', 'app_metadata.region'] }`,
        "twice",
      ],
      [`{ columns: ['region'] }`, "without a table"],
    ] as const) {
      const result = await attrs(value);
      expect(result.code).toBe(2);
      expect(result.output).toContain(message);
    }
    const meta = await attrs(`{ columns: ['app_metadata.plan'] }`);
    expect(meta.code).toBe(0);
    expect(meta.sql).not.toContain("has_column_privilege");
  });

  it("gives suspended users empty claims", async () => {
    const { sql } = await generate(
      `{ memberships: [${SOURCES}] }`,
      [],
      `{ suspension: { users: { table: 'profiles', id: 'id', disabledAt: 'disabled_at' } } }`,
    );
    expect(sql).toContain(
      `claims := claims || jsonb_build_object('user_role', '[]'::jsonb, 'roles', '[]'::jsonb, 'memberships', '[]'::jsonb);`,
    );
  });

  it("writes extra claims outside the budget and strips them for suspended users", async () => {
    const { code, sql } = await generate(
      `{ memberships: [${SOURCES}], claims: { features: 'billing.feature_claims' } }`,
      [],
      `{ suspension: { users: { table: 'profiles', id: 'id', disabledAt: 'disabled_at' } } }`,
    );
    expect(code).toBe(0);
    expect(sql).toContain(`extra := "billing"."feature_claims"(uid);`);
    expect(sql).toContain(`claims := jsonb_set(claims, '{features}', extra);`);
    expect(sql).toContain(
      `claims := claims - 'memberships_truncated' - 'attrs' - 'tenant_id' - 'features';`,
    );
    expect(sql).toContain(`claims := claims - 'attrs' - 'features';`);
    expect(sql).toContain(
      'grant execute on function "billing"."feature_claims"(uuid) to supabase_auth_admin;',
    );
    expect(sql).toContain(
      'grant usage on schema "billing" to supabase_auth_admin;',
    );
    const suspendedBranch = sql.slice(
      sql.indexOf("if not "),
      sql.indexOf("end if;", sql.indexOf("if not ")),
    );
    expect(suspendedBranch).not.toContain("feature_claims");
    const loopEnd = sql.indexOf("end loop;");
    expect(sql.indexOf('feature_claims"(uid')).toBeGreaterThan(loopEnd);
    expect(sql.split("\n", 1)[0]).toBe(
      "-- permdock:hook v1 schema=permdock tenant=tenant_id budget=1024 claims=user_role,roles,memberships,memberships_truncated,tenant_id,authz_ver,features",
    );
  });

  it("writes keep for a source whose suspended scope keeps permissions", async () => {
    const keep = `{ scopes: { organization: { table: 'organizations', id: 'id', disabledAt: 'disabled_at', keep: ['invoice.read'] } } }`;
    const { code, sql, cwd } = await generate(
      `{ memberships: [
        junctionMembershipSource({ table: 'organization_users', scope: 'organization', roles: 'role', suspension: ${keep} }),
        junctionMembershipSource({ table: 'customer_contacts', scope: 'customer', within: { organization: 'organization_id' }, roles: ['contact'] }),
      ] }`,
      [],
      `{ suspension: ${keep} }`,
    );
    expect(code).toBe(0);
    expect(
      sql.match(/'entitlements', s\.seats, 'keep', s\.keep/gu),
    ).toHaveLength(3);
    expect(sql).toContain("null::jsonb as keep");
    const manifest: SupabaseHookManifest = jsonData(
      (await run(["supabase", "inspect", "--json"], { cwd })).stdout,
    );
    expect(manifest.rls.suspension?.scopes?.["organization"]).toEqual({
      table: "public.organizations",
      id: "id",
      disabledAt: "disabled_at",
      keep: ["invoice.read"],
    });
  });

  it("calls each supabase.hook.before function first and returns its error", async () => {
    const { code, sql, cwd } = await generate(
      `{ memberships: [${SOURCES}], before: ['auth_checks.require_sso', 'auth_checks.require_mfa'], claims: { features: 'auth_checks.feature_claims' } }`,
    );
    expect(code).toBe(0);
    expect(sql).toContain(
      '  checked jsonb;\nbegin\n  checked := "auth_checks"."require_sso"(event);',
    );
    expect(sql.indexOf('"require_sso"(event)')).toBeLessThan(
      sql.indexOf('"require_mfa"(event)'),
    );
    expect(sql).toContain(`  if checked ? 'error' then
    return checked;
  end if;
  event := checked;`);
    expect(sql).toContain(
      "'message', 'auth_checks.require_mfa returned no event'",
    );
    expect(sql).toContain("  claims := event -> 'claims';");
    expect(
      sql.match(
        /grant usage on schema "auth_checks" to supabase_auth_admin;/gu,
      ),
    ).toHaveLength(1);
    expect(sql).toContain(
      'grant execute on function "auth_checks"."require_sso"(jsonb) to supabase_auth_admin;',
    );
    const manifest: SupabaseHookManifest = jsonData(
      (await run(["supabase", "inspect", "--json"], { cwd })).stdout,
    );
    expect(manifest.hook.before).toEqual([
      "auth_checks.require_sso",
      "auth_checks.require_mfa",
    ]);

    const plain = await generate(`{ memberships: [${SOURCES}] }`);
    expect(plain.sql).not.toContain("checked");
  });

  it("drops every PermDock claim that fails supabase.hook.validate", async () => {
    const { code, sql } = await generate(
      `{ memberships: [${SOURCES}], validate: true, claims: { features: 'auth_checks.feature_claims' } }`,
    );
    expect(code).toBe(0);
    expect(sql).toContain(
      '  if not extensions.jsonb_matches_schema(\'{"$schema":"https://json-schema.org/draft/2020-12/schema","$ref":"#/$defs/permdockClaims"',
    );
    expect(sql).toContain(
      "::json, claims) then\n    claims := claims - 'user_role' - 'roles' - 'memberships' - 'memberships_truncated' - 'attrs' - 'authz_ver' - 'tenant_id';\n  end if;\n  return jsonb_set(event, '{claims}', claims);",
    );
    expect(sql).toContain(
      "grant execute on function extensions.jsonb_matches_schema(json, jsonb) to supabase_auth_admin;",
    );

    const plain = await generate(`{ memberships: [${SOURCES}] }`);
    expect(plain.sql).not.toContain("jsonb_matches_schema");
  });

  it("refuses a supabase.hook.before function without a schema", async () => {
    const { code, output } = await generate(
      `{ memberships: [${SOURCES}], before: 'require_sso' }`,
    );
    expect(code).not.toBe(0);
    expect(output).toContain(
      "supabase.hook.before must name schema-qualified functions",
    );
  });

  it("quotes a schema-qualified junctionMembershipSource table and grants usage on its schema", async () => {
    const { code, sql } = await generate(
      `{ memberships: [junctionMembershipSource({ table: 'billing.memberships', scope: 'organization', id: 'org_id', roles: 'role' })], roles: false }`,
    );
    expect(code).toBe(0);
    expect(sql).toContain('from "billing"."memberships"');
    expect(sql).not.toContain('"billing.memberships"');
    expect(sql).toContain(
      'grant usage on schema "billing" to supabase_auth_admin;',
    );
    expect(sql).toContain(
      'grant select on table "billing"."memberships" to supabase_auth_admin;',
    );
  });

  it("refuses reserved or unqualified extra claims", async () => {
    for (const [claims, message] of [
      [`{ memberships: 'x.f' }`, "PermDock or Supabase Auth writes"],
      [`{ tenant_id: 'x.f' }`, "PermDock or Supabase Auth writes"],
      [`{ role: 'x.f' }`, "PermDock or Supabase Auth writes"],
      [`{ __proto__x: 'x.f', ['__proto__']: 'x.f' }`, "prototype key"],
      [`{ features: 'feature_claims' }`, "schema-qualified"],
      [`{ features: 'x.f(); drop' }`, "schema-qualified"],
    ] as const) {
      const result = await generate(
        `{ memberships: [${SOURCES}], claims: ${claims} }`,
      );
      expect(result.code).toBe(2);
      expect(result.output).toContain(message);
    }
  });
});
