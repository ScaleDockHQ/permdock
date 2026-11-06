import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import { followPolicies, walkChainSql } from "../../src/cli/rls/follows.ts";
import { tablelessResources } from "../../src/cli/sql/tables.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { definePermissions, definePolicy, resource } from "../../src/index.ts";

const permissions = definePermissions({
  job: resource({
    actions: ["read", "update"],
    parent: { field: "managerId", resource: "job" },
  }),
});

const policy = definePolicy(permissions, { subject: () => null });

const ctx: RlsSqlContext = {
  dialect: "supabase",
  scopes: scopeList(undefined),
  tenantClaim: "tenant_id",
  gucPrefix: "app",
};

const tables = {
  job: {
    table: "public.jobs",
    also: ["jobParty"],
    follows: { "public.job_parties": "job_id" },
    walk: "recursive",
  },
} as const;

describe("rls.tables follows and walk", () => {
  it("gives an also resource no policies of its own", () => {
    expect(tablelessResources(tables)).toStrictEqual(new Set(["jobParty"]));
  });

  it("writes child policies that call can_job and no child permission", () => {
    const policies = followPolicies(ctx, policy, tables);
    expect(policies.map((item) => item.command)).toStrictEqual([
      "select",
      "insert",
      "update",
      "delete",
    ]);
    const select = policies[0];
    expect(select?.table).toBe("public.job_parties");
    expect(select?.using).toContain(
      `exists (select 1 from "public"."jobs" p where p."id" = "job_parties"."job_id" and "permdock".can_job(p, 'job.read'))`,
    );
    expect(policies[1]?.check).toContain("can_job(p, 'job.update')");
    expect(policies[2]?.using).toContain("can_job(p, 'job.update')");
    expect(policies[2]?.check).toContain("can_job(p, 'job.update')");
    expect(policies.map((item) => item.using).join(" ")).not.toContain(
      "jobParty",
    );
  });

  it("emits one recursive chain and adds delegation covers when asked", () => {
    const plain = walkChainSql(ctx, policy, tables, false);
    expect(plain).toContain(
      'create or replace function "permdock".permdock_job_chain()',
    );
    expect(plain).toContain(
      'where t."managerId" = (select "permdock".permdock_user_id())',
    );
    expect(plain).not.toContain("approval_delegations");
    expect(plain).not.toContain("reporting_");
    expect(plain).not.toContain("accessible_");
    expect(walkChainSql(ctx, policy, tables, true)).toContain(
      '"permdock".approval_delegations',
    );
  });
});
