import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import { approvalManagersSql } from "../../src/cli/rls/approval-managers.ts";
import { approvalsSql } from "../../src/cli/rls/approvals.ts";

const ctx: RlsSqlContext = {
  dialect: "supabase",
  scopes: [{ name: "tenant" }],
  tenantClaim: "tenant_id",
  gucPrefix: "app",
};

const managers = {
  table: "public.reporting_lines",
  user: "user_id",
  manager: "manager_id",
};

describe("rls.approvals.managers", () => {
  it("walks the manager table with a depth cap and a cycle guard", () => {
    const sql = approvalManagersSql(
      ctx,
      managers,
      '"permdock".permdock_is_approver',
      false,
    );
    expect(sql).toContain(
      'create or replace function "permdock".permdock_manages(p_requester text, p_levels integer)',
    );
    expect(sql).toContain('from "public"."reporting_lines" m');
    expect(sql).toContain("where c.depth < least(p_levels, 8)");
    expect(sql).toContain('and not (m."manager_id"::text = any (c.path))');
    expect(sql).toContain("and p_levels between 1 and 8");
    expect(sql).toContain("and p_user <> p_requester");
    expect(sql).toMatch(
      /select "permdock"\.permdock_manages_for\(\(select .+\)::text, p_requester, p_levels\)/u,
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_manages_for(text, text, integer) from public, anon, authenticated;',
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_manages(text, integer) from public, anon, authenticated;',
    );
    expect(sql).toContain(
      'create or replace function "permdock".permdock_is_approver(p_approvers jsonb, p_tenant text, p_requester text, p_resource text)',
    );
    expect(sql).toContain(
      'grant execute on function "permdock".permdock_is_approver(jsonb, text, text, text) to authenticated;',
    );
  });

  it("leaves the four-argument check to the covers when delegations are on", () => {
    const sql = approvalsSql(ctx, { managers, delegations: true }, false);
    expect(
      sql?.match(
        /create or replace function "permdock"\.permdock_is_approver\(p_approvers jsonb, p_tenant text, p_requester text, p_resource text\)/gu,
      ),
    ).toHaveLength(1);
    expect(sql).toContain(
      'if "permdock".permdock_approves(p_approvers, p_tenant, p_requester) then',
    );
    expect(approvalsSql(ctx, { delegations: true }, false)).not.toContain(
      "permdock_approves",
    );
  });

  it("lets a cover pass on a manager leaf when the delegator manages the requester", () => {
    const sql = approvalsSql(ctx, { managers, delegations: true }, false);
    expect(sql).toContain(
      'return coalesce("permdock".permdock_manages_for(p_delegator::text, p_requester, v_levels::text::integer), false);',
    );
    expect(approvalsSql(ctx, { delegations: true }, false)).not.toContain(
      "permdock_manages_for",
    );
  });

  it("refuses managers without a table and both columns", () => {
    for (const given of [
      {},
      { table: "t", user: "u" },
      { table: "", user: "u", manager: "m" },
    ]) {
      expect(() =>
        // SAFETY: the test passes configs the type rules out, as a JavaScript config may.
        approvalsSql(ctx, { managers: given as typeof managers }, false),
      ).toThrow("rls.approvals.managers needs { table, user, manager }");
    }
  });
});
