import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import { decidingColumns } from "../../src/cli/deciding-columns.ts";
import { compileGrants } from "../../src/cli/rls-compile.ts";
import { helpersSql } from "../../src/cli/rls-helpers.ts";
import { indexTargets } from "../../src/cli/rls-indexes.ts";
import { ownershipRules, ownershipSql } from "../../src/cli/rls-ownership.ts";
import {
  supabaseHookManifest,
  supabaseHookSql,
} from "../../src/cli/supabase-hook.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { fromJunction, fromTable } from "../../src/supabase/index.ts";
import { policy } from "../fixtures/named-scopes.ts";

const scopes = scopeList(policy.scopes);
const ownership = ownershipRules(policy, scopes);
const user = {
  through: "contact_profiles",
  on: { contact_profile_id: "id" },
  column: "user_id",
};
const roleKey = { through: "roles", on: { role_id: "id" }, column: "key" };
const suspension = {
  users: { table: "profiles", id: "user_id", disabledAt: "disabled_at" },
  scopes: {
    organization: { table: "organizations", id: "id", disabledAt: "closed_at" },
  },
};

const organizationUsers = fromJunction({
  table: "organization_users",
  scope: "organization",
  roles: roleKey,
  via: "staff",
  suspension,
});

const customerContacts = fromJunction({
  table: "customer_contacts",
  scope: "customer",
  id: "customer_id",
  within: { organization: "organization_id" },
  user,
  roles: ["contact"],
  via: "contact",
  suspension,
});

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
  supabase: { hook: { memberships: [organizationUsers, customerContacts] } },
};

describe("membership sources with a user through a profile table", () => {
  it("reads the user from the profile table and lets supabase_auth_admin read it", () => {
    const { sql, manifest } = supabaseHookSql(scopes, config);
    expect(sql).toContain(
      'v_user_1 "public"."contact_profiles"."user_id"%type := uid;',
    );
    expect(sql).toMatch(
      /from "public"\."customer_contacts" m\n\s+join "public"\."contact_profiles" mu on mu\."id" = m\."contact_profile_id"\n\s+where mu\."user_id" = v_user_1/u,
    );
    expect(sql).toContain(
      'grant select on table "public"."contact_profiles" to supabase_auth_admin;',
    );
    expect(sql).toContain(
      'create policy "permdock_auth_admin_read_member_users" on "public"."contact_profiles"',
    );
    expect(manifest.memberships[1]?.user).toEqual({
      column: "contact_profile_id",
      through: {
        table: "public.contact_profiles",
        id: "id",
        column: "user_id",
      },
    });
  });

  it("bumps the users a membership row references and both users of a re-linked profile", () => {
    const { sql } = supabaseHookSql(scopes, config);
    expect(sql).toContain(
      `create trigger "permdock_authz_version"
  after insert or update or delete on "public"."organization_users"
  for each row execute function "permdock".permdock_bump_authz_version('user_id');`,
    );
    expect(sql).not.toContain(
      `permdock_bump_authz_version('contact_profile_id')`,
    );
    expect(fn(sql, "permdock_bump_authz_version_member_users"))
      .toContain(`  perform "permdock".permdock_bump_authz_version_for(array(
    select u."user_id"::uuid from "public"."contact_profiles" u
    where ((tg_op <> 'INSERT' and u."id" = old."contact_profile_id")
       or (tg_op <> 'DELETE' and u."id" = new."contact_profile_id"))
      and exists (select 1 from auth.users a where a.id = u."user_id"::uuid)
  ));`);
    expect(sql).toContain(
      `create trigger "permdock_authz_version"
  after insert or update or delete on "public"."customer_contacts"
  for each row execute function "permdock".permdock_bump_authz_version_member_users();`,
    );
    expect(sql).toContain(
      `create trigger "permdock_authz_version_user_id"
  after update of "user_id", "id" or delete on "public"."contact_profiles"
  for each row execute function "permdock".permdock_bump_authz_version_linked_users('user_id');`,
    );
    expect(fn(sql, "permdock_bump_authz_version_linked_users")).toContain(
      "where exists (select 1 from auth.users a where a.id = u)",
    );
  });

  it("branches on the table when two sources read users through profile tables", () => {
    const { sql } = supabaseHookSql(scopes, {
      ...config,
      supabase: {
        hook: {
          memberships: [
            customerContacts,
            customerContacts,
            fromTable({ table: "memberships", columns: { user } }),
          ],
        },
      },
    });
    const body = fn(sql, "permdock_bump_authz_version_member_users");
    expect(body).toContain(
      `if tg_table_schema = 'public' and tg_table_name = 'customer_contacts' then`,
    );
    expect(body).toContain(
      `if tg_table_schema = 'public' and tg_table_name = 'memberships' then`,
    );
    expect(body.match(/perform/gu)).toHaveLength(2);
    expect(
      sql.match(/create trigger "permdock_authz_version_user_id"/gu),
    ).toHaveLength(1);
  });

  it("joins the profile table when a renamed role key bumps its holders", () => {
    const { sql } = supabaseHookSql(scopes, {
      ...config,
      supabase: {
        hook: {
          memberships: [
            fromJunction({
              table: "customer_contacts",
              scope: "customer",
              id: "customer_id",
              within: { organization: "organization_id" },
              user,
              roles: roleKey,
            }),
          ],
        },
      },
    });
    expect(sql).toContain(
      `select u."user_id"::uuid as user_id from "public"."customer_contacts" h join "public"."contact_profiles" u on u."id" = h."contact_profile_id" where h."role_id" = old."id"`,
    );
    expect(sql).toMatch(
      /join "public"\."contact_profiles" mu on mu\."id" = m\."contact_profile_id"\n\s+join "public"\."roles" mk on mk\."id" = m\."role_id"/u,
    );
  });

  it("counts the reference and the profile table's id and user as deciding columns", () => {
    expect(decidingColumns(config)).toEqual([
      "public.contact_profiles.id",
      "public.contact_profiles.user_id",
      "public.customer_contacts.contact_profile_id",
      "public.customer_contacts.customer_id",
      "public.customer_contacts.organization_id",
      "public.organization_users.organization_id",
      "public.organization_users.role_id",
      "public.organization_users.user_id",
      "public.roles.id",
      "public.roles.key",
    ]);
    expect(supabaseHookManifest(scopes, config).decidingColumns).toContain(
      "public.contact_profiles.user_id",
    );
  });

  it("joins the profile table in every database-mode helper and keeps suspension", () => {
    const sources = [organizationUsers, customerContacts];
    const sql = helpers({
      ...base,
      authorize: "database",
      sources,
      memberSources: sources,
      suspension,
    });
    for (const name of [
      "permitted_customer_ids",
      "member_customer_ids",
      "member_customer_ids_for",
    ]) {
      const body = fn(sql, name);
      expect(body).toContain('"public"."contact_profiles"."user_id"%type');
      expect(body).toContain(
        'join "public"."contact_profiles" mu on mu."id" = m."contact_profile_id"',
      );
      expect(body).toContain(
        's."user_id"::text = (mu."user_id")::text and s."disabled_at" is null',
      );
      expect(body).toContain('s."closed_at" is null');
    }
  });

  it("leaves jwt-mode helpers on the claims", () => {
    const sql = helpers({
      ...base,
      sources: [customerContacts],
      memberSources: [customerContacts],
    });
    expect(fn(sql, "permitted_customer_ids")).not.toContain(
      '"public"."contact_profiles"',
    );
    expect(fn(sql, "member_customer_ids_for")).toContain(
      'join "public"."contact_profiles" mu',
    );
  });

  it("answers permdock_can_assign from a source whose user is in a profile table", () => {
    const sql = ownershipSql({
      ...base,
      authorize: "database",
      sources: [customerContacts],
      ownership: {
        kinds: {},
        assigns: [{ assigner: "contact", scope: "customer", role: "contact" }],
        counted: [],
      },
    });
    expect(fn(sql, "permdock_can_assign")).toContain(
      'v_user_0 "public"."contact_profiles"."user_id"%type := (select auth.uid());',
    );
  });

  it("indexes the reference and the profile table's user column", () => {
    const targets = indexTargets(
      { ...base, sources: [customerContacts] },
      [],
    ).map((target) => `${target.table}(${target.columns.join(",")})`);
    expect(targets).toEqual([
      "public.contact_profiles(user_id)",
      "public.customer_contacts(contact_profile_id)",
    ]);
  });
});
