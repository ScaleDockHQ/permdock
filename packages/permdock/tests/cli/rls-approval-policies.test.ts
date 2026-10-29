import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import { approvalPoliciesSql } from "../../src/cli/rls/approval-policies.ts";
import { approvalsSql } from "../../src/cli/rls/approvals.ts";

const ctx: RlsSqlContext = {
  dialect: "supabase",
  scopes: [{ name: "tenant" }],
  tenantClaim: "tenant_id",
  gucPrefix: "app",
};

describe("rls.approvals.tenantPolicies", () => {
  it("writes the table, manage-gated writes and an owner-only reader", () => {
    const sql = approvalPoliciesSql(ctx, { manage: "approvalPolicy.manage" });
    expect(sql).toContain(
      'create table if not exists "permdock".approval_policies',
    );
    expect(sql).toContain("body ? 'approval'");
    expect(sql).toMatch(
      /create policy "approval_policies_read"[\s\S]*using \(tenant is null or tenant in/u,
    );
    expect(sql).toMatch(
      /create policy "approval_policies_insert"[\s\S]*with check \(tenant is not null and [\s\S]*'approvalPolicy\.manage'/u,
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_approval_policies_for(text[]) from public, anon, authenticated;',
    );
    expect(sql).not.toContain("service_role");
  });

  it("guards writes with permdock_actor_may_write under rls.readOnlyActors", () => {
    const guard = '(select "permdock".permdock_actor_may_write())';
    expect(approvalPoliciesSql(ctx, { manage: "a.b" })).not.toContain(guard);
    const sql = approvalsSql(
      ctx,
      { tenantPolicies: { manage: "a.b" } },
      false,
      true,
    );
    expect(
      /create policy "approval_policies_insert"[^;]*;/u.exec(sql ?? "")?.[0],
    ).toContain(guard);
  });

  it.each([
    ["no manage", {}],
    ["a manage that is not a key", { manage: "x; drop table y" }],
    ["a boolean", true],
  ])("refuses %s", (_label, options) => {
    expect(() => approvalPoliciesSql(ctx, options)).toThrow(/manage/u);
  });

  it("needs a tenant scope", () => {
    expect(() =>
      approvalPoliciesSql({ ...ctx, scopes: [] }, { manage: "a.b" }),
    ).toThrow(/tenant scope/u);
  });
});
