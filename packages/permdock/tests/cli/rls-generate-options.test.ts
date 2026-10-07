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

  it("guards the global-roles table and the caller's own rows", async () => {
    const outcome = await generate({
      roles: { table: "app.user_roles" },
      assignments: { ownRole: "refuse" },
    });
    expect(outcome.text).toContain(
      `-- app.user_roles: a client role may write only the global roles it may assign, and none on its own rows`,
    );
    expect(outcome.text).toContain(
      `-- organization_members: a client role may write only the tenant roles it may assign, and none on its own rows`,
    );
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

writeFileSync(
  path.join(cwd, "fields.ts"),
  `import { allow, definePermissions, definePolicy, resource, role } from 'permdock';
import { z } from 'zod';

const Quote = z.object({ id: z.string(), orgId: z.string(), customerId: z.string(), total: z.number(), margin: z.number() });
const permissions = definePermissions({
  quote: resource(Quote, {
    id: 'id',
    actions: ['read'],
    relations: {
      org: { field: 'orgId', memberOf: 'tenant' },
      customer: { field: 'customerId', memberOf: 'customer' },
    },
  }),
});

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: 'orgId' }, customer: { key: 'customerId', within: 'tenant' } },
  roles: [
    role('staff', [allow(permissions.quote.read)], { on: 'tenant' }),
    role('contact', [allow(permissions.quote.read, { fields: ['id', 'orgId', 'customerId', 'total'] })], { on: 'customer' }),
  ],
  subject: () => null,
});
`,
);

describe("field views with hand-written policies", () => {
  const run = (rls: NonNullable<PermDockConfig["rls"]>) =>
    runRlsGenerate({
      cwd,
      config: { policy: "./fields.ts", rls },
      target: "sql",
      dialect: "supabase",
      rbac: false,
      check: false,
      skipClosures: false,
      inlineFunctions: false,
      io,
      write: false,
    });

  it("writes the per-scope field view next to the helpers and no policy", async () => {
    const outcome = await run({
      helpersOnly: true,
      fields: "views",
      tables: { quote: "quotes" },
    });
    expect(outcome.code).toBe(0);
    expect(outcome.text).toContain(
      'create or replace view "public"."quotes_visible" with (security_invoker = true) as',
    );
    expect(outcome.text).toContain(
      `case when "orgId" in (select "permdock".permitted_tenant_ids('quote.read#1'))`,
    );
    expect(outcome.text).not.toContain("create policy");
    expect(outcome.output).toContain(
      "revoke select on those columns from client roles in your own grants",
    );
  });

  it("refuses --revoke-columns, whose grants it does not own", async () => {
    const outcome = await run({
      helpersOnly: true,
      fields: "views",
      revokeColumns: true,
    });
    expect(outcome.code).toBe(2);
  });
});
