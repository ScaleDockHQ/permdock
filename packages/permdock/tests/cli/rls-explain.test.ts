import { describe, expect, it } from "vitest";

import type { RlsRunInput } from "../../src/cli/rls/rls.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import { describeExplain, type RlsExplain } from "../../src/cli/rls/explain.ts";
import { runRls } from "../../src/cli/rls/rls.ts";

describe("describeExplain", () => {
  const base: RlsExplain = {
    schema: "permdock",
    authorize: "database",
    scopes: [
      { name: "organization", key: "organization_id" },
      { name: "project", key: "project_id", within: "organization" },
    ],
    bindings: [
      { resource: "post", table: "public.post", inferred: true, exists: false },
      { resource: "doc", table: "public.docs", inferred: false },
    ],
    membershipSources: [
      { table: "public.members", select: "select 1\nfrom x" },
    ],
    customRoles: {
      table: "public.roles",
      key: "key",
      tenant: "org",
      shared: "shared",
      skip: "builtin",
      holds: ["tenant", "shared", "global"],
    },
    rowHelpers: [{ resource: "post", permissions: ["post.read"] }],
    triggers: [{ name: "t1", table: "public.roles", reason: "why" }],
  };

  it("prints every section", () => {
    const text = describeExplain(base);
    expect(text).toContain("scopes: organization (organization_id), project");
    expect(text).toContain("within organization");
    expect(text).toContain("public.post (named after the resource");
    expect(text).toContain("MISSING");
    expect(text).toContain("  public.members\n    select 1\n    from x");
    expect(text).toContain(
      "custom roles: public.roles (key key, tenant org, shared shared, skip builtin); holds tenant, shared, global roles",
    );
    expect(text).toContain("  post: post.read");
    expect(text).toContain("  t1 on public.roles (why)");
  });

  it("omits the sections that are empty", () => {
    const text = describeExplain({
      ...base,
      membershipSources: [],
      customRoles: { table: "r", key: "k", holds: ["global"] },
      rowHelpers: [],
      triggers: [],
    });
    expect(text).not.toContain("membership sources:");
    expect(text).not.toContain("row helpers:");
    expect(text).not.toContain("generated triggers:");
    expect(text).toContain("custom roles: r (key k); holds global roles");
  });
});

const POLICY = new URL("../fixtures/named-scopes.ts", import.meta.url).pathname;

function input(config: PermDockConfig): RlsRunInput {
  // SAFETY: explain reads only the fields set here; the rest keep their flag defaults.
  return {
    cwd: process.cwd(),
    config,
    rest: ["explain"],
    json: true,
    io: { stdout: () => undefined, stderr: () => undefined },
  } as unknown as RlsRunInput;
}

async function explained(rls: NonNullable<PermDockConfig["rls"]>) {
  const result = await runRls(input({ policy: POLICY, rls }));
  expect(result.code).toBe(0);
  const report: RlsExplain = JSON.parse(result.output);
  return report;
}

describe("runRls explain with options", () => {
  it("reports the custom roles table and the row helpers", async () => {
    const report = await explained({
      dialect: "supabase",
      rowHelpers: true,
      customRoles: true,
      customRoleWrites: {
        roles: {
          table: "app_roles",
          key: "key",
          tenant: "organization_id",
          shared: "shared",
          skip: "builtin",
        },
      },
    });
    expect(report.customRoles).toEqual({
      table: "app_roles",
      key: "key",
      tenant: "organization_id",
      shared: "shared",
      skip: "builtin",
      holds: ["tenant", "shared", "global"],
    });
    expect(report.rowHelpers.length).toBeGreaterThan(0);
    expect(report.triggers).toEqual(expect.any(Array));
  });

  it("lists the resources a rowHelpers array names", async () => {
    const report = await explained({
      dialect: "supabase",
      rowHelpers: ["quote"],
    });
    expect(report.rowHelpers.map((helper) => helper.resource)).toEqual([
      "quote",
    ]);
  });

  it("holds tenant and global roles in a table without a shared column", async () => {
    const report = await explained({
      dialect: "supabase",
      customRoles: true,
      customRoleWrites: {
        roles: { table: "app_roles", key: "key", tenant: "organization_id" },
      },
    });
    expect(report.customRoles?.holds).toEqual(["tenant", "global"]);
  });

  it("marks a table-less roles table as global only", async () => {
    const report = await explained({
      dialect: "supabase",
      customRoles: true,
      customRoleWrites: { roles: { table: "app_roles", key: "key" } },
    });
    expect(report.customRoles?.holds).toEqual(["global"]);
  });
});
