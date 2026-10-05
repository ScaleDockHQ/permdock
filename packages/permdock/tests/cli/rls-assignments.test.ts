import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { assignmentSql, ownershipRules } from "../../src/cli/rls-ownership.ts";
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
