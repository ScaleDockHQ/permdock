import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import {
  assignmentSql,
  ownershipRules,
  ownershipSql,
} from "../../src/cli/rls-ownership.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { policy } from "../fixtures/named-scopes.ts";

const scopes = scopeList(policy.scopes);
const base: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes,
  gucPrefix: "app",
  tenantType: "uuid",
  authorize: "database",
  memberships: {
    scopes: {
      organization: {
        table: "organization_users",
        user: "user_id",
        role: { through: "roles", on: { role_id: "id" }, column: "key" },
        columns: { organization: "organization_id" },
      },
    },
  },
};
const ownership = ownershipRules(policy, scopes);

describe("assignment triggers", () => {
  it("writes nothing without rls.assignments or an assigns graph", () => {
    expect(
      assignmentSql({
        ...base,
        ...(ownership === undefined ? {} : { ownership }),
      }),
    ).toBe("");
    expect(assignmentSql({ ...base, assignments: { tables: [] } })).toBe("");
  });

  it("checks a role read through a roles table on the memberships table and the extra tables", () => {
    const sql = assignmentSql({
      ...base,
      ...(ownership === undefined ? {} : { ownership }),
      assignments: {
        tables: [
          {
            table: "contact_invites",
            scope: "customer",
            id: "customer_id",
            tenant: "organization_id",
            role: "role",
          },
        ],
      },
    });
    expect(sql).toContain(
      `foreach v_role in array array[(select newk."key"::text from "public"."roles" newk where newk."id" = new."role_id")]::text[] loop`,
    );
    expect(sql).toContain(
      `"permdock".permdock_can_assign(v_role, new."organization_id"::text)`,
    );
    expect(sql).toContain(
      `if not (current_user::text = any(array['anon', 'anonymous', 'authenticated'])) then`,
    );
    expect(sql).toContain(
      `create trigger "permdock_assignment"\n  before insert or update or delete on "public"."contact_invites"`,
    );
    expect(sql).not.toContain("security definer");
    expect(sql).not.toContain("permdock_can_assign_custom_role");
  });

  it("checks a custom role on a row with no instance as a platform custom role", () => {
    const ctx: RlsSqlContext = {
      ...base,
      ...(ownership === undefined ? {} : { ownership }),
      customRoles: { declared: ["owner", "admin"], assignable: [] },
      assignments: {
        tables: [
          {
            table: "invitations",
            scope: "organization",
            id: "organization_id",
            role: "role",
          },
        ],
      },
    };
    const sql = `${ownershipSql(ctx)}${assignmentSql(ctx)}`;
    expect(sql).toContain(
      `when new."organization_id"::text is null then "permdock".permdock_can_assign_custom_role(null, 'global', null, v_role)`,
    );
    expect(sql).toContain("c.tenant_id is not distinct from p_tenant");
    expect(sql).not.toContain("permdock_can_assign_custom_role_for");
  });

  it("refuses an extra table below the first scope without its tenant column", () => {
    expect(() =>
      assignmentSql({
        ...base,
        ...(ownership === undefined ? {} : { ownership }),
        assignments: {
          tables: [
            {
              table: "invites",
              scope: "customer",
              id: "customer_id",
              role: "role",
            },
          ],
        },
      }),
    ).toThrow(/name its tenant column/u);
  });
});

describe("permdock_can_assign_any", () => {
  const withOwnership: RlsSqlContext = {
    ...base,
    ...(ownership === undefined ? {} : { ownership }),
  };

  it("answers a declared role through permdock_can_assign, in both forms", () => {
    const sql = ownershipSql(withOwnership);
    expect(sql).toContain(
      `create or replace function "permdock".permdock_can_assign_any(p_role text, p_tenant uuid, p_scope text, p_scope_id text)`,
    );
    expect(sql).toContain(
      `select coalesce("permdock".permdock_can_assign(p_role, case when p_scope = 'global' then null else p_scope_id end), false)`,
    );
    expect(sql).toContain(
      `grant execute on function "permdock".permdock_can_assign_any(text, uuid, text, text) to authenticated;`,
    );
    expect(sql).toContain(
      `create or replace function "permdock".permdock_can_assign_any_for(p_user uuid, p_role text, p_tenant uuid, p_scope text, p_scope_id text)`,
    );
    expect(sql).toContain(
      `"permdock".permdock_can_assign_for(p_user, p_role, case when p_scope = 'global' then null else p_scope_id end)`,
    );
    expect(sql).toContain(
      `revoke execute on function "permdock".permdock_can_assign_any_for(uuid, text, uuid, text, text) from public, anon, authenticated;`,
    );
    expect(sql).not.toContain("permdock_can_assign_custom_role");
  });

  it("branches between declared and custom roles, without rls.assignments", () => {
    const sql = ownershipSql({
      ...withOwnership,
      customRoles: { declared: ["owner", "admin"], assignable: [] },
    });
    expect(sql).toContain(
      'create or replace function "permdock".permdock_can_assign_custom_role(p_tenant uuid',
    );
    expect(sql).toContain(
      `when p_role = any(array['owner', 'admin']::text[]) then "permdock".permdock_can_assign(p_role, case when p_scope = 'global' then null else p_scope_id end)`,
    );
    expect(sql).toContain(
      `when p_scope = 'global' then "permdock".permdock_can_assign_custom_role(null, 'global', null, p_role)`,
    );
    expect(sql).toContain(
      `else "permdock".permdock_can_assign_custom_role(p_tenant, p_scope, p_scope_id, p_role)`,
    );
    expect(sql).not.toContain("permdock_can_assign_any_for");
  });

  it("writes only the caller form in jwt mode, and nothing without assigns", () => {
    const jwt = ownershipSql({ ...withOwnership, authorize: "jwt" });
    expect(jwt).toContain("permdock_can_assign_any(");
    expect(jwt).not.toContain("permdock_can_assign_any_for");
    expect(ownershipSql(base)).toBe("");
  });
});
