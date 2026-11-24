import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";
import type { RlsApprovalManagers } from "../../src/cli/types.ts";

import { approvalsSql } from "../../src/cli/rls/approvals.ts";
import { parseSqlFile } from "../../src/cli/sql/ast.ts";

const ctx: RlsSqlContext = {
  dialect: "supabase",
  scopes: [{ name: "organization" }],
  tenantClaim: "tenant_id",
  gucPrefix: "app",
};

const employees = {
  table: "public.employees",
  id: "id",
  reportsTo: "manager_employee_id",
  user: "user_id",
  tenant: "organization_id",
  active: { status: "status", inactive: ["ended"] },
};

function generated(managers: object, delegations = false): string {
  // SAFETY: the tests pass invalid shapes on purpose; approvalsSql validates them.
  const given = managers as RlsApprovalManagers;
  return approvalsSql(ctx, { managers: given, delegations }, false) ?? "";
}

async function bodies(sql: string): Promise<readonly string[]> {
  const out: string[] = [];
  for (const match of sql.matchAll(
    /language sql[\s\S]*?as \$\$([\s\S]*?)\$\$;/gu,
  )) {
    const body = match[1] ?? "";
    await parseSqlFile(`${body};`);
    out.push(body);
  }
  return out;
}

describe("rls.approvals.managers on a self-referencing table", () => {
  it("writes the row helpers and the request approver set", async () => {
    const sql = generated(employees);
    for (const name of [
      'permdock_manages_row(p_row "public"."employees"."id"%type)',
      "permdock_managed_row_ids_in(p_tenant uuid)",
      "permdock_managed_row_ids()",
      "permdock_accessible_row_ids(p_permission text)",
      "permdock_request_approver_ids(p_requester uuid, p_tenant uuid)",
    ]) {
      expect(sql).toContain(`create or replace function "permdock".${name}`);
    }
    expect(sql).toContain(
      '"permdock".permitted_organization_ids_by_permission(p_permission)',
    );
    expect(sql).toContain(
      `(e."status" is null or e."status" not in ('ended'))`,
    );
    expect(sql).toContain(
      'join "public"."employees" b on b."id" = e."manager_employee_id" and b."organization_id" = e."organization_id"',
    );
    expect((await bodies(sql)).length).toBeGreaterThan(8);
  });

  it("keeps the caller out of every managed set", () => {
    const sql = generated(employees);
    const managed = sql.slice(
      sql.indexOf("permdock_managed_row_ids_in("),
      sql.indexOf("permdock_managed_row_ids()"),
    );
    expect(managed.match(/r\."user_id" is distinct from/gu)).toHaveLength(2);
    expect(sql).toContain("select id from up where id <> p_requester");
  });

  it("adds active covers of each manager to the approver set", () => {
    const sql = generated(employees, true);
    const approvers = sql.slice(sql.indexOf("permdock_request_approver_ids("));
    expect(approvers).toContain("join up u on u.id = d.delegator");
    expect(approvers).toContain("and d.delegate <> p_requester");
  });

  it("writes only the approver set for an edge table", () => {
    const sql = generated({
      table: "public.reporting_lines",
      user: "user_id",
      manager: "manager_id",
      tenant: "tenant_id",
    });
    expect(sql).toContain("permdock_request_approver_ids(");
    expect(sql).not.toContain("permdock_manages_row");
  });

  it("names the columns a self-referencing table needs", () => {
    expect(() =>
      generated({ table: "employees", id: "id", user: "u" }),
    ).toThrow(/\{ table, id, reportsTo, user \}/u);
    expect(() =>
      generated({ ...employees, active: { status: "status" } }),
    ).toThrow(/active needs \{ status \}/u);
  });
});
