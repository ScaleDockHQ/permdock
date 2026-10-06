import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";
import type {
  PermDockConfig,
  RlsMembershipTable,
} from "../../src/cli/types.ts";

import { decidingColumns } from "../../src/cli/deciding-columns.ts";
import { compileGrants } from "../../src/cli/rls-compile.ts";
import { helpersSql } from "../../src/cli/rls-helpers.ts";
import { ownershipRules, ownershipSql } from "../../src/cli/rls-ownership.ts";
import { compileConditionSql } from "../../src/cli/rls-sql.ts";
import {
  supabaseHookManifest,
  supabaseHookSql,
} from "../../src/cli/supabase-hook.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  authorizeSql,
  fromJunction,
  fromTable,
} from "../../src/supabase/index.ts";
import { policy } from "../fixtures/named-scopes.ts";

const scopes = scopeList(policy.scopes);
const ownership = ownershipRules(policy, scopes);
const through = { through: "roles", on: { role_id: "id" }, column: "key" };
const suspension = {
  users: { table: "profiles", id: "user_id", disabledAt: "disabled_at" },
  scopes: {
    organization: { table: "organizations", id: "id", disabledAt: "closed_at" },
  },
};

const organizationUsers = fromJunction({
  table: "organization_users",
  scope: "organization",
  roles: through,
  via: "staff",
  suspension,
});

const table: RlsMembershipTable = {
  table: "organization_users",
  user: "user_id",
  role: through,
  columns: { organization: "organization_id" },
};

const base: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes,
  gucPrefix: "app",
  tenantType: "uuid",
  ...(ownership === undefined ? {} : { ownership }),
};

function helpers(ctx: RlsSqlContext): string {
  const compiled = compileGrants(policy, ctx, undefined, [], false);
  return helpersSql(ctx, compiled.rolePermissions, { userRoles: false });
}

/** The `create function ... $$;` block of `name`. */
function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function "permdock".${name}(`);
  return start === -1 ? "" : sql.slice(start, sql.indexOf("$$;", start));
}

const config: PermDockConfig = {
  policy: "p.ts",
  rls: { roles: { table: "user_roles", role: through } },
  supabase: { hook: { memberships: [organizationUsers] } },
};

describe("membership sources through a roles table", () => {
  it("mints memberships from roles.key and lets supabase_auth_admin read roles", () => {
    const { sql, manifest } = supabaseHookSql(scopes, config);
    expect(sql).toMatch(
      /from "public"\."organization_users" m\n\s+join "public"\."roles" mk on mk\."id" = m\."role_id"/u,
    );
    expect(sql).toContain(
      'grant select on table "public"."roles" to supabase_auth_admin;',
    );
    expect(sql.match(/permdock_auth_admin_read_role_keys" on/gu)).toHaveLength(
      2,
    );
    expect(manifest.memberships[0]?.role).toEqual({
      column: "role_id",
      through: { table: "public.roles", id: "id", column: "key" },
    });
  });

  it("bumps the global and the membership holders of a renamed key from one trigger", () => {
    const { sql } = supabaseHookSql(scopes, config);
    expect(sql).toContain(`  if tg_op = 'UPDATE'
    and new."key" is not distinct from old."key"
    and new."id" is not distinct from old."id" then
    return null;
  end if;`);
    expect(sql)
      .toContain(`    select h."user_id"::uuid as user_id from "public"."user_roles" h where h."role_id" = old."id"
    union
    select h."user_id"::uuid as user_id from "public"."organization_users" h where h."role_id" = old."id"`);
    expect(
      sql.match(/after update or delete on "public"\."roles"/gu),
    ).toHaveLength(1);
  });

  it("branches on the table when holders reference different roles tables", () => {
    const { sql } = supabaseHookSql(scopes, {
      ...config,
      rls: {
        roles: {
          table: "user_roles",
          role: { ...through, through: "platform_roles" },
        },
      },
    });
    expect(sql).toContain(
      `if tg_table_schema = 'public' and tg_table_name = 'platform_roles' then`,
    );
    expect(sql).toContain(
      `if tg_table_schema = 'public' and tg_table_name = 'roles' then`,
    );
    expect(sql).toContain(
      'create trigger "permdock_authz_version"\n  after update or delete on "public"."platform_roles"',
    );
    expect(sql).toContain(
      'create trigger "permdock_authz_version"\n  after update or delete on "public"."roles"',
    );
  });

  it("lists a holder table once when two sources read it", () => {
    const { sql } = supabaseHookSql(scopes, {
      ...config,
      supabase: {
        hook: { memberships: [organizationUsers, organizationUsers] },
      },
    });
    expect(
      sql.match(/from "public"\."organization_users" h where/gu),
    ).toHaveLength(1);
  });

  it("counts the roles table's id and key as deciding columns", () => {
    expect(decidingColumns(config)).toEqual([
      "public.organization_users.organization_id",
      "public.organization_users.role_id",
      "public.organization_users.user_id",
      "public.roles.id",
      "public.roles.key",
    ]);
  });

  it("joins the roles table in every database-mode helper and keeps suspension", () => {
    const sources = [organizationUsers];
    const sql = helpers({
      ...base,
      authorize: "database",
      sources,
      memberSources: sources,
      suspension,
    });
    for (const name of [
      "permitted_organization_ids",
      "member_organization_ids",
      "member_organization_ids_for",
    ]) {
      const body = fn(sql, name);
      expect(body).toContain(
        'join "public"."roles" mk on mk."id" = m."role_id"',
      );
      expect(body).toContain('s."disabled_at" is null');
      expect(body).toContain('s."closed_at" is null');
    }
  });

  it("answers permdock_can_assign from the sources in database mode", () => {
    const sql = ownershipSql({
      ...base,
      authorize: "database",
      sources: [organizationUsers],
    });
    const canAssign = fn(sql, "permdock_can_assign");
    expect(canAssign).toContain("language plpgsql");
    expect(canAssign).toContain(
      'v_user_0 "public"."organization_users"."user_id"%type := (select auth.uid());',
    );
    expect(canAssign).toContain('join "public"."roles" mk');
    expect(canAssign).toContain("and ms.id = p_scope_id");
    expect(canAssign).toContain(
      "(r.role, p_role) in (values ('owner', 'owner')",
    );
  });

  it("answers permdock_can_assign from the sources without membership kinds", () => {
    const sql = ownershipSql({
      ...base,
      authorize: "database",
      sources: [organizationUsers],
      suspension,
      ownership: {
        kinds: {},
        assigns: [
          {
            assigner: "owner",
            scope: "organization",
            role: "admin",
            at: "organization",
          },
        ],
        counted: [],
      },
    });
    const canAssign = fn(sql, "permdock_can_assign");
    expect(canAssign).toContain(
      "(r.role, p_role) in (values ('owner', 'admin'))\n        and exists",
    );
    expect(canAssign).not.toContain("case r.role");
  });

  it("leaves jwt-mode helpers on the claims", () => {
    const sql = helpers({ ...base, sources: [organizationUsers] });
    expect(fn(sql, "permitted_organization_ids")).not.toContain(
      '"public"."roles"',
    );
    expect(fn(sql, "permitted_organization_ids")).toContain("auth.jwt()");
  });
});

describe("rls.memberships through a roles table", () => {
  const ctx: RlsSqlContext = {
    ...base,
    authorize: "database",
    memberships: { scopes: { organization: table } },
  };

  it("joins the roles table in the helpers and the ownership objects", () => {
    const sql = helpers(ctx);
    expect(fn(sql, "permitted_organization_ids"))
      .toContain(`  from "public"."organization_users" m
  join "public"."roles" mk on mk."id" = m."role_id"
  join "permdock".role_permissions rp on rp.role = mk."key"::text`);
    expect(fn(sql, "member_organization_ids")).toContain(
      'and mk."key"::text is not null',
    );
    const own = ownershipSql(ctx);
    expect(fn(own, "permdock_holders_organization"))
      .toContain(`      join "public"."roles" mk on mk."id" = m."role_id"
      where m."organization_id" = v_key
        and mk."key"::text = 'owner'`);
    expect(fn(own, "permdock_can_assign")).toContain(
      `(mk."key"::text, p_role) in (values ('owner', 'owner')`,
    );
  });

  it("resolves custom roles by the joined key", () => {
    const sql = helpers({
      ...ctx,
      customRoles: { declared: ["owner"], assignable: ["owner"] },
    });
    expect(fn(sql, "permitted_organization_ids")).toContain(
      'c.role = mk."key"::text',
    );
  });

  it("joins the roles table for transfer-only roles", () => {
    const own = ownershipSql({
      ...ctx,
      ownership: {
        kinds: {},
        assigns: [],
        counted: [
          { role: "owner", scope: "organization", min: 1, transferOnly: true },
        ],
      },
    });
    expect(own).toContain(
      `select n."organization_id" as id, nk."key"::text as role, 1 as delta from permdock_new n join "public"."roles" nk on nk."id" = n."role_id" where nk."key"::text = any(array['owner']::text[])`,
    );
  });

  it("compiles memberOf through the roles table", () => {
    const sql = compileConditionSql(
      {
        op: "memberOf",
        scope: "organization",
        field: "organization_id",
        roles: ["admin"],
      },
      { ...ctx, memberships: { tenant: table } },
    );
    expect(sql).toContain(`from "organization_users" m where`);
    expect(sql).toContain(
      `(select mk."key"::text from "public"."roles" mk where mk."id" = m."role_id") = any('{admin}')`,
    );
  });

  it("lists the reference column and the roles table in the hook manifest", () => {
    const manifest = supabaseHookManifest(scopes, {
      ...config,
      rls: { memberships: { scopes: { organization: table } } },
    });
    expect(manifest.rls.memberships).toContainEqual(
      expect.objectContaining({
        role: {
          column: "role_id",
          through: { table: "public.roles", id: "id", column: "key" },
        },
      }),
    );
  });
});

describe("authorizeSql through a roles table", () => {
  it("joins the roles table for tenant requests and custom roles", () => {
    const sql = authorizeSql({
      tenant: {
        table: "organization_users",
        user: "user_id",
        tenant: "organization_id",
        role: through,
      },
      customRoles: { declared: ["owner"] },
    });
    expect(sql).toContain(`from "public"."organization_users" m
      join "public"."roles" mk on mk."id" = m."role_id"
      join "permdock"."role_permissions" rp on rp.role = mk."key"::text`);
    expect(sql).toContain('c.role = mk."key"::text');
    expect(sql).toContain('not (mk."key"::text = any(');
  });

  it("refuses a through with more than one join column", () => {
    expect(() =>
      fromTable({
        table: "memberships",
        columns: { role: { ...through, on: { a: "id", b: "id" } } },
      }),
    ).toThrow("must map exactly one column");
  });
});
