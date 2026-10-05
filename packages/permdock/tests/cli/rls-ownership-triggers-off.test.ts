import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { ownershipRules, ownershipSql } from "../../src/cli/rls-ownership.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { policy } from "../fixtures/named-scopes.ts";

const scopes = scopeList(policy.scopes);
const ownership = ownershipRules(policy, scopes);
const base: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes,
  gucPrefix: "app",
  authorize: "database",
  memberships: {
    scopes: {
      organization: {
        table: "organization_users",
        user: "user_id",
        role: "role",
        columns: { organization: "organization_id" },
      },
    },
  },
  ...(ownership === undefined ? {} : { ownership }),
};

describe("rls.ownershipTriggers", () => {
  it("writes the holder-count trigger by default", () => {
    expect(ownershipSql(base)).toContain("permdock_holders_organization");
  });

  it("leaves the triggers out for a skipped scope and keeps permdock_can_assign", () => {
    for (const skip of ["all", ["organization"]] as const) {
      const sql = ownershipSql({ ...base, skipOwnershipTriggers: skip });
      expect(sql).not.toContain("permdock_holders_organization");
      expect(sql).toContain(
        "-- organization: rls.ownershipTriggers leaves out the triggers",
      );
      expect(sql).toContain("permdock_can_assign");
    }
  });
});
