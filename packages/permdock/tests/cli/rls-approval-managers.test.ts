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
  tenant: "tenant_id",
};

describe("rls.approvals.managers", () => {
  it("walks the manager table with a depth cap and a cycle guard", () => {
    const sql = approvalManagersSql(
      ctx,
      managers,
      '"permdock".permdock_is_approver',
      '"permdock".permdock_is_approver_base',
      false,
    );
    expect(sql).toContain(
      'create or replace function "permdock".permdock_manages(p_requester text, p_levels integer, p_tenant text default null)',
    );
    expect(sql).toContain('from "public"."reporting_lines" m');
    expect(sql).toContain("where c.depth < least(p_levels, 8)");
    expect(sql).toContain('and not (m."manager_id"::text = any (c.path))');
    expect(sql).toContain("and p_levels between 1 and 8");
    expect(sql).toContain("and p_user <> p_requester");
    expect(sql).toMatch(
      /select "permdock"\.permdock_manages_for\(\(select .+\)::text, p_requester, p_levels, p_tenant\)/u,
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_manages_for(text, text, integer, text) from public, anon, authenticated;',
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_manages(text, integer, text) from public, anon, authenticated;',
    );
    expect(sql).toContain(
      'create or replace function "permdock".permdock_is_approver(p_approvers jsonb, p_tenant text, p_requester text, p_resource text)',
    );
    expect(sql).toContain(
      'grant execute on function "permdock".permdock_is_approver(jsonb, text, text, text) to authenticated;',
    );
  });

  it("routes the three-argument check through permdock_approves and keeps the base for other leaves", () => {
    const sql = approvalsSql(ctx, { managers }, false) ?? "";
    expect(sql).not.toContain("drop function if exists");
    expect(sql).toContain(
      'create or replace function "permdock".permdock_is_approver(p_approvers jsonb, p_tenant text default null, p_requester text default null)',
    );
    expect(sql).toContain(
      'select coalesce("permdock".permdock_approves(p_approvers, p_tenant, p_requester), false)',
    );
    expect(sql).toContain(
      'create or replace function "permdock".permdock_is_approver_base(p_approvers jsonb, p_tenant text default null)',
    );
    expect(sql).toContain(
      'return "permdock".permdock_is_approver_base(p_approvers, p_tenant);',
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_is_approver_base(jsonb, text) from public, anon, authenticated;',
    );
    expect(sql).toContain("permdock_approver_for_ids");
    expect(sql).toContain("permdock_managed_user_ids");
    expect(sql).toContain('m."user_id" <>');
    expect(sql).not.toContain("approval_delegations");
  });

  it("keeps the two-argument check as it was without managers", () => {
    const sql = approvalsSql(ctx, { delegations: true }, false) ?? "";
    expect(sql).toContain(
      'create or replace function "permdock".permdock_is_approver(p_approvers jsonb, p_tenant text default null)',
    );
    expect(sql).not.toContain("permdock_is_approver_base");
    expect(sql).not.toContain("drop function if exists");
    expect(sql).toContain("d.delegator::text");
    expect(sql).toContain('d."until" > now()');
    expect(sql).not.toContain("permdock_managed_user_ids");
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
      'return coalesce("permdock".permdock_manages_for(p_delegator::text, p_requester, v_levels::text::integer, p_tenant), false);',
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

describe("rls.approvals approval sets", () => {
  const withManagers = (
    scopes: RlsSqlContext["scopes"],
    tenant: string | undefined,
  ): string =>
    approvalsSql(
      { ...ctx, scopes },
      {
        managers: {
          table: managers.table,
          user: managers.user,
          manager: managers.manager,
          ...(tenant === undefined ? {} : { tenant }),
        },
      },
      false,
    ) ?? "";

  it("returns setof uuid on Supabase with no ::text cast in the sets", () => {
    const sql = withManagers([{ name: "tenant" }], "organization_id");
    const start = sql.indexOf("permdock_approver_for_ids()");
    const sets = sql.slice(start);
    expect(sets).toContain("returns setof uuid");
    expect(sets).not.toContain("returns setof text");
    expect(sets).not.toContain("::text");
  });

  it("filters the downward walk by tenant on the seed and every step", () => {
    const sql = withManagers([{ name: "tenant" }], "organization_id");
    expect(sql).toContain("permdock_managed_user_ids(p_tenant uuid)");
    expect(sql.match(/m\."organization_id" = p_tenant(?!::)/gu)).toHaveLength(
      2,
    );
  });

  it("filters the upward walk by the request's tenant", () => {
    const sql = withManagers([{ name: "tenant" }], "organization_id");
    expect(sql.match(/m\."organization_id" = p_tenant::uuid/gu)).toHaveLength(
      2,
    );
    expect(sql).toContain(
      "permdock_manages_for(p_user text, p_requester text, p_levels integer, p_tenant text default null)",
    );
  });

  it("refuses managers without a tenant column when the policy has a tenant scope", () => {
    expect(() => withManagers([{ name: "tenant" }], undefined)).toThrow(
      /managers needs `tenant`/u,
    );
  });
});

describe("rls.approvals approval sets without a tenant scope", () => {
  const plain: RlsSqlContext = {
    dialect: "neon",
    scopes: [],
    tenantClaim: "tenant_id",
    gucPrefix: "app",
  };
  const bare = {
    table: managers.table,
    user: managers.user,
    manager: managers.manager,
  };

  it("walks without a tenant filter and returns text ids on a dialect with text users", () => {
    const sql = approvalsSql(plain, { managers: bare }, false) ?? "";
    expect(sql).toContain("permdock_managed_user_ids()");
    expect(sql).toContain("returns setof text");
    expect(sql).not.toContain("p_tenant uuid");
    expect(sql).not.toContain('"tenant_id"::text = p_tenant');
  });

  it("refuses a tenant that is not a column name", () => {
    expect(() =>
      approvalsSql(plain, { managers: { ...bare, tenant: "" } }, false),
    ).toThrow(/must be a column name/u);
  });
});
