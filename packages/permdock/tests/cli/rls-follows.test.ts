import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";

import {
  followPolicies,
  treeHelperSql,
  walkChainSql,
} from "../../src/cli/rls/follows.ts";
import { tablelessResources } from "../../src/cli/sql/tables.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { definePermissions, definePolicy, resource } from "../../src/index.ts";

const permissions = definePermissions({
  job: resource({
    actions: ["read", "update"],
    parent: { field: "managerId", resource: "job" },
    relations: { org: { field: "orgId", memberOf: "tenant" } },
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
    user: "ownerId",
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
      `exists (select 1 from "public"."jobs" p where p."id" = "job_parties"."job_id" and "permdock".can_job(p, 'job.read'::text))`,
    );
    expect(policies[1]?.check).toContain("can_job(p, 'job.update'::text)");
    expect(policies[2]?.using).toContain("can_job(p, 'job.update'::text)");
    expect(policies[2]?.check).toContain("can_job(p, 'job.update'::text)");
    expect(policies.map((item) => item.using).join(" ")).not.toContain(
      "jobParty",
    );
  });

  it("starts the chain at the caller's row through tables.<resource>.user", () => {
    const plain = walkChainSql(ctx, policy, tables, false);
    expect(plain).toContain(
      'create or replace function "permdock".permdock_job_chain()',
    );
    expect(plain).toContain(
      'where t."ownerId" = (select "permdock".permdock_user_id())',
    );
    expect(plain).not.toContain('t."managerId" = (select');
    expect(plain).toContain('on c."managerId" = w.id');
    expect(plain).not.toContain("approval_delegations");
    expect(plain).not.toContain("reporting_");
    expect(plain).not.toContain("accessible_");
  });

  it("defaults the start column to the id column", () => {
    const sql = walkChainSql(
      ctx,
      policy,
      { job: { table: "public.users", walk: "recursive" } },
      false,
    );
    expect(sql).toContain(
      'where t."id" = (select "permdock".permdock_user_id())',
    );
  });

  it("guards the path, caps the depth and keeps the start row's tenant", () => {
    const sql = walkChainSql(ctx, policy, tables, false);
    expect(sql).toContain('not c."id" = any (w.path)');
    expect(sql).toContain("w.depth < 32");
    expect(sql).toContain('c."orgId" = w.tenant');
    expect(sql).toContain("where depth >= 1");
  });

  it("seeds each covered delegator's row and returns it", () => {
    const sql = walkChainSql(ctx, policy, tables, true);
    expect(sql).toContain('t."ownerId" = d.delegator');
    expect(sql).toContain('"permdock".approval_delegations');
    expect(sql).toContain("or cover");
  });

  it("walks only the treeValues folder, inside the caller's tenants", () => {
    const sql = treeHelperSql(ctx, policy, tables, {
      "public.jobs": { name: "kept" },
    });
    expect(sql).toContain(
      'create or replace function "permdock".permdock_tree_job()',
    );
    expect(sql).toContain('from "public"."jobs" t');
    expect(sql).toContain(
      'where t."orgId" in (select "permdock".member_tenant_ids())',
    );
    expect(sql).toContain('join tree w on c."managerId" = w.id');
    expect(sql).not.toContain("name");
    expect(() =>
      treeHelperSql(ctx, policy, tables, { "public.other": {} }),
    ).toThrow(/self-parented folder/u);
    expect(treeHelperSql(ctx, policy, tables, { job: {} })).toContain(
      "permdock_tree_job",
    );
  });

  it("skips a child table and refuses a follows or walk the policy cannot name", () => {
    expect(
      followPolicies(ctx, policy, {
        child: { tableOf: "job" },
        job: tables.job,
      }).map((item) => item.table),
    ).toStrictEqual([
      "public.job_parties",
      "public.job_parties",
      "public.job_parties",
      "public.job_parties",
    ]);
    expect(
      walkChainSql(ctx, policy, { job: { table: "public.jobs" } }, false),
    ).toBe("");
    expect(() =>
      followPolicies(ctx, policy, {
        ghost: { table: "public.ghosts", follows: { "public.child": "id" } },
      }),
    ).toThrow(/does not declare/u);
    const long = "a".repeat(70);
    expect(() =>
      followPolicies(ctx, policy, {
        job: {
          table: "public.jobs",
          follows: { [`public.${long}`]: "job_id" },
        },
      }),
    ).toThrow(/63 bytes/u);
    expect(() =>
      walkChainSql(
        ctx,
        policy,
        { ghost: { table: "public.ghosts", walk: "recursive" } },
        false,
      ),
    ).toThrow(/self-parented resource/u);
    const loose = definePolicy(
      definePermissions({
        folder: resource({
          actions: ["read"],
          parent: { field: "parentId", resource: "folder" },
        }),
      }),
      { subject: () => null },
    );
    expect(() =>
      treeHelperSql(
        ctx,
        loose,
        { folder: { table: "public.folders", walk: "recursive" } },
        { "public.folders": {} },
      ),
    ).toThrow(/self-parented folder/u);
  });
});
