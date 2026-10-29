import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import {
  approvalDelegationsSql,
  approvalsSql,
} from "../../src/cli/rls/approvals.ts";

const ctx: RlsSqlContext = {
  dialect: "supabase",
  scopes: [{ name: "tenant" }],
  tenantClaim: "tenant_id",
  gucPrefix: "app",
};

describe("rls.approvals.delegations", () => {
  it("writes the covers table, its owner-only policies and the four-argument check", () => {
    const sql = approvalDelegationsSql(ctx);
    expect(sql).toContain(
      'create table if not exists "permdock".approval_delegations',
    );
    expect(sql).toContain("delegate uuid not null");
    expect(sql).toContain('check ("from" < "until")');
    expect(sql).toContain("check (delegator <> delegate)");
    expect(sql).toContain(
      'grant select, insert, update, delete on table "permdock".approval_delegations to authenticated;',
    );
    expect(sql).toMatch(
      /create policy "approval_delegations_insert"[\s\S]*with check \(delegator::text = .* and \(tenant is null or tenant in \(select m\.id::text from "permdock"\.member_tenant_ids\(\) m\(id\)\)\)\)/u,
    );
    expect(sql).toContain(
      'create or replace function "permdock".permdock_is_approver(p_approvers jsonb, p_tenant text, p_requester text, p_resource text)',
    );
    expect(sql).toContain("and d.delegator::text <> p_requester");
    expect(sql).toContain("and d.permissions is null");
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_cover_approves(uuid, jsonb, text, text) from public, anon, authenticated;',
    );
  });

  it("guards every cover write with permdock_actor_may_write under rls.readOnlyActors", () => {
    const guard = '(select "permdock".permdock_actor_may_write())';
    expect(approvalDelegationsSql(ctx)).not.toContain(
      "permdock_actor_may_write",
    );
    const sql = approvalDelegationsSql(ctx, true);
    for (const command of ["insert", "update", "delete"]) {
      const statement = new RegExp(
        `create policy "approval_delegations_${command}"[^;]*;`,
        "u",
      ).exec(sql)?.[0];
      expect(statement).toContain(guard);
    }
    expect(
      /create policy "approval_delegations_read"[^;]*;/u.exec(sql)?.[0],
    ).not.toContain(guard);
    expect(approvalsSql(ctx, { delegations: true }, false, true)).toContain(
      guard,
    );
  });

  it("checks holder() approvers through a cover only in database mode", () => {
    expect(approvalDelegationsSql(ctx)).not.toContain(
      "permdock_has_permission_for",
    );
    const database = approvalDelegationsSql({ ...ctx, authorize: "database" });
    expect(database).toContain(
      '"permdock".permdock_has_permission_for(p_delegator',
    );
    expect(database).toContain(
      '"permdock".permitted_tenant_ids_by_permission_for(p_delegator',
    );
  });

  it("adds the covers to the generated or the adopted store", () => {
    expect(approvalsSql(ctx, true, false)).not.toContain(
      "approval_delegations",
    );
    expect(approvalsSql(ctx, { delegations: true }, false)).toMatch(
      /approval_requests[\s\S]*approval_delegations/u,
    );
    expect(
      approvalsSql(ctx, { table: "approvals", delegations: true }, false),
    ).toMatch(/"public"\."approvals"[\s\S]*approval_delegations/u);
    expect(approvalsSql(ctx, false, false)).toBeUndefined();
  });

  it("refuses adopt options without a table and a non-boolean delegations", () => {
    expect(() => approvalsSql(ctx, { mirror: { status: "s" } }, false)).toThrow(
      "rls.approvals.mirror adopts a table; set rls.approvals.table too",
    );
    expect(() =>
      approvalsSql(ctx, JSON.parse('{"delegations":"yes"}'), false),
    ).toThrow("rls.approvals.delegations must be a boolean");
  });

  it("writes covers and the approver check without a store", () => {
    const sql = approvalsSql(ctx, { store: false, delegations: true }, false);
    expect(sql).not.toContain("approval_requests");
    expect(sql).not.toContain("permdock_approval_open");
    expect(sql).toContain(
      'create table if not exists "permdock".approval_delegations',
    );
    expect(sql).toContain(
      'create or replace function "permdock".permdock_is_approver(p_approvers jsonb, p_tenant text default null)',
    );
    expect(approvalsSql(ctx, { store: false }, false)).toContain(
      "permdock_is_approver(p_approvers jsonb, p_tenant text default null)",
    );
    expect(() =>
      approvalsSql(ctx, { store: false, table: "approvals" }, false),
    ).toThrow("rls.approvals.table configures the approval store");
    expect(() =>
      approvalsSql(ctx, JSON.parse('{"store":"no"}'), false),
    ).toThrow("rls.approvals.store must be a boolean");
  });

  it("writes the five-argument check over the current step with covers or managers", () => {
    const signature =
      'create or replace function "permdock".permdock_is_approver(p_approvers jsonb, p_tenant text, p_requester text, p_resource text, p_request_approvers jsonb)';
    const sql = approvalsSql(ctx, { delegations: true }, false);
    expect(sql).toContain(signature);
    expect(sql).toContain(
      "jsonb_array_elements_text(p_request_approvers -> 'users')",
    );
    expect(sql).toContain(
      "case when p_request_approvers -> 'manager' = 'true'::jsonb then '[{\"kind\": \"manager\"}]'::jsonb",
    );
    expect(sql).toContain(
      'grant execute on function "permdock".permdock_is_approver(jsonb, text, text, text, jsonb) to authenticated;',
    );
    expect(approvalsSql(ctx, true, false)).not.toContain("p_request_approvers");
  });
});
