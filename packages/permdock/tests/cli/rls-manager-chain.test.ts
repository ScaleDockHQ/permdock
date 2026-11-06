import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import { closureDepths, graphPlan, graphSql } from "../../src/cli/rls/graph.ts";
import { compileGrants } from "../../src/cli/sql/compile.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  relation,
  resource,
} from "../../src/index.ts";

const id = z.uuid();

const permissions = definePermissions({
  employee: resource(z.object({ id, managerId: id.nullable() }), {
    actions: ["review"],
    parent: { field: "managerId", resource: "employee" },
    relations: { manager: { principal: "managerId" } },
  }),
  timeEntry: resource(z.object({ id, employeeId: id }), {
    actions: ["read"],
    parent: { field: "employeeId", resource: "employee" },
  }),
});

const policy = definePolicy(permissions, {
  grants: [
    allow(permissions.timeEntry.read, {
      to: relation(permissions.employee, "manager", {
        through: "parent",
        depth: 8,
      }),
    }),
    allow(permissions.employee.review, {
      to: relation(permissions.employee, "manager", {
        through: "parent",
        depth: 8,
      }),
    }),
  ],
  subject: () => null,
});

function context(): RlsSqlContext {
  return {
    dialect: "supabase",
    scopes: scopeList(policy.scopes),
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    graph: { closures: closureDepths(graphPlan(policy)) },
  };
}

describe("manager chains over the closure graph", () => {
  it("keeps a closure for the self-parented employee only", () => {
    expect(closureDepths(graphPlan(policy))).toStrictEqual({ employee: 8 });
  });

  it("reads a time entry through the manager's closure descendants", () => {
    const ctx = context();
    const compiled = compileGrants(policy, ctx, undefined, [], false, true);
    const read = compiled.branches.find(
      (branch) => branch.permissionKey === "timeEntry.read",
    );
    expect(read?.using).toBe(
      `"employeeId" in (select descendant::uuid from "permdock".permdock_closure where resource = 'employee' and ancestor::uuid = any (array(select "permdock".permitted_employee_ids('manager'))))`,
    );
  });

  it("writes the closure triggers and the principal helper", () => {
    const sql = graphSql(context(), graphPlan(policy), undefined);
    expect(sql).toContain("permdock_closure");
    expect(sql).toContain("permitted_employee_ids");
  });
});
