import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import { runRlsGenerate } from "../../src/cli/rls-generate.ts";
import { assignmentSql, ownershipRules } from "../../src/cli/rls-ownership.ts";
import { supabaseHookSql } from "../../src/cli/supabase-hook.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { fromJunction } from "../../src/supabase/index.ts";
import { policy as namedScopes } from "../fixtures/named-scopes.ts";

const TMP = path.join(import.meta.dirname, "../../tmp");
mkdirSync(TMP, { recursive: true });
const cwd = mkdtempSync(path.join(TMP, "rls-generate-options-"));
writeFileSync(
  path.join(cwd, "manage.ts"),
  `import { allow, definePermissions, definePolicy, resource, role } from 'permdock';

const permissions = definePermissions({
  job: resource({ id: 'id', actions: ['read'], relations: { org: { field: 'orgId', memberOf: 'tenant' } } }),
  member: resource({ collection: { assignRole: { manageRoles: true } } }),
});

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: 'orgId' } },
  roles: [
    role('owner', [allow([permissions.job.read, permissions.member.assignRole])], {
      on: 'tenant',
      min: 1,
      assigns: ['owner', 'member'],
    }),
    role('member', [allow(permissions.job.read)], { on: 'tenant' }),
  ],
  subject: () => null,
});
`,
);

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const io = { stdout: () => undefined, stderr: () => undefined };
const memberships = {
  tenant: {
    table: "organization_members",
    tenant: "organization_id",
    user: "user_id",
    role: "role",
  },
};

function generate(rls: NonNullable<PermDockConfig["rls"]>) {
  return runRlsGenerate({
    cwd,
    config: {
      policy: "./manage.ts",
      rls: { authorize: "database", customRoles: true, memberships, ...rls },
    },
    target: "sql",
    dialect: "supabase",
    rbac: false,
    check: false,
    skipClosures: false,
    inlineFunctions: false,
    io,
    write: false,
  });
}

describe("rls generate options", () => {
  it("reads manageRoles for the write requirement and the hand-out lift", async () => {
    const outcome = await generate({
      customRoleWrites: { requires: "manageRoles" },
    });
    expect(outcome.code).toBe(0);
    expect(outcome.text).toContain(
      "rp.permission = any(array['member.assignRole']::text[])",
    );
  });

  it("leaves holder triggers out per scope and refuses an unknown scope", async () => {
    const off = await generate({ ownershipTriggers: { tenant: false } });
    expect(off.text).toContain(
      "-- tenant: rls.ownershipTriggers leaves out the triggers",
    );
    await expect(
      generate({ ownershipTriggers: { region: false } }),
    ).rejects.toThrow("rls.ownershipTriggers.region names a scope");
  });

  it("checks custom roles in the assignment triggers", async () => {
    const outcome = await generate({ assignments: true });
    expect(outcome.text).toContain("permdock_can_assign_custom_role");
    expect(outcome.text).toContain(
      "case when v_role = any(array['member', 'owner']::text[]) then",
    );
    const none = await generate({ assignments: true, customRoles: false });
    expect(none.text).not.toContain("permdock_can_assign_custom_role");
  });

  it("writes no assignment trigger for a policy without assigns", () => {
    const scopes = scopeList(namedScopes.scopes);
    const ownership = ownershipRules(namedScopes, scopes);
    const ctx: RlsSqlContext = {
      dialect: "supabase",
      tenantClaim: "tenant_id",
      scopes,
      gucPrefix: "app",
      authorize: "database",
      assignments: { tables: [] },
      customRoles: { declared: [], assignable: [] },
      ...(ownership === undefined
        ? {}
        : { ownership: { ...ownership, assigns: [] } }),
    };
    expect(assignmentSql(ctx)).toBe("");
  });

  it("puts the held custom roles in subject_for in database mode", () => {
    const hook = supabaseHookSql(scopeList(namedScopes.scopes), {
      rls: { authorize: "database", customRoles: true },
      supabase: {
        hook: {
          memberships: [
            fromJunction({
              table: "organization_users",
              scope: "organization",
              roles: "role",
            }),
          ],
        },
      },
    });
    expect(hook.sql).toContain('"permdock".subject_for(p_user uuid)');
    expect(hook.sql).toContain('from "permdock".custom_role_permissions p');
    const jwt = supabaseHookSql(scopeList(namedScopes.scopes), {
      supabase: {
        hook: {
          memberships: [
            fromJunction({
              table: "organization_users",
              scope: "organization",
              roles: "role",
            }),
          ],
        },
      },
    });
    expect(jwt.sql).not.toContain("custom_role_permissions");
  });
});
