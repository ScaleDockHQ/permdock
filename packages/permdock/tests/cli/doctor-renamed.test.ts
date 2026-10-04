import { afterAll, describe, expect, it } from "vitest";

import { pd055 } from "../../src/cli/doctor-collect.ts";
import { pd056 } from "../../src/cli/doctor-sql.ts";
import { project, removeProjects } from "./doctor-kit.ts";

afterAll(removeProjects);

const POLICY = `import { allow, definePermissions, definePolicy, resource, role } from 'permdock';

const permissions = definePermissions(
  { customer: resource({ actions: ['read', 'update'], relations: { org: { field: 'orgId', memberOf: 'tenant' } } }) },
  { renamed: { 'customer.view': 'customer.read' } },
);

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: 'orgId' } },
  roles: [role('agent', [allow(permissions.customer.read), allow(permissions.customer.update)], { on: 'tenant' })],
  subject: () => null,
});
`;

describe("PD055 custom roles stored under a former key", () => {
  it("names the stored key and the update that rewrites it", async () => {
    const cwd = project({
      "src/policy.ts": POLICY,
      "memberships.json": JSON.stringify({
        customRoles: [
          {
            tenant: "o1",
            name: "support",
            grants: [
              { permission: "customer.view" },
              { permission: "customer.update" },
            ],
          },
        ],
      }),
    });
    const config = {
      policy: "./src/policy.ts",
      doctor: { memberships: "./memberships.json" },
    };
    expect(await pd055({ cwd, config })).toEqual([
      {
        code: "PD055",
        severity: "warning",
        message:
          "custom role support in o1 stores customer.view, which was renamed to customer.read",
        fix: "rewrite the stored key before removing the alias: update permdock.custom_role_permissions set permission = 'customer.read' where permission = 'customer.view';",
      },
    ]);
    expect(await pd055({ cwd, config: { policy: "./src/policy.ts" } })).toEqual(
      [],
    );
    expect(
      await pd055({
        cwd,
        config: { ...config, doctor: { memberships: "./missing.json" } },
      }),
    ).toEqual([]);
    const [inApp] = await pd055({
      cwd,
      config: { ...config, rls: { schema: "app" } },
    });
    expect(inApp?.fix).toContain("update app.custom_role_permissions");
    const bare = project({
      "src/policy.ts": POLICY,
      "memberships.json": JSON.stringify({}),
    });
    expect(await pd055({ cwd: bare, config })).toEqual([]);
  });
});

describe("PD056 callers of a legacy helper", () => {
  const config = {
    rls: {
      migrate: {
        helpers: {
          is_member: { form: "membership", scope: "tenant" },
          org_ids: { form: "ids", scope: "tenant" },
        },
      },
    },
  } as const;

  it("counts calls outside the helper's own definition and grants", () => {
    const cwd = project({
      "supabase/migrations/001_legacy.sql": `create or replace function public.is_member(p_id uuid) returns boolean language sql as $$ select true $$;
revoke execute on function public.is_member(uuid) from public;
create policy p on public.notes using (public.is_member(org_id));
create function public.visible(p uuid) returns boolean language sql as $$ select is_member(p) $$;
-- is_member(x) in a comment does not count
`,
      "supabase/migrations/002_more.sql": `create policy q on public.docs using (org_id in (select org_ids('doc.read')));\n`,
    });
    expect(pd056(cwd, config)).toEqual([
      {
        code: "PD056",
        severity: "warning",
        message:
          "legacy helper is_member is still called 2 time(s), in supabase/migrations/001_legacy.sql",
        fix: "run permdock rls migrate --write for policies, rewrite function bodies, views and triggers onto the permdock helpers by hand, then drop function is_member",
      },
      {
        code: "PD056",
        severity: "warning",
        message:
          "legacy helper org_ids is still called 1 time(s), in supabase/migrations/002_more.sql",
        fix: "run permdock rls migrate --write for policies, rewrite function bodies, views and triggers onto the permdock helpers by hand, then drop function org_ids",
      },
    ]);
  });

  it("is quiet without rls.migrate or with no callers", () => {
    const cwd = project({
      "supabase/migrations/001.sql": `create or replace function public.is_member(p_id uuid) returns boolean language sql as $$ select true $$;\n`,
    });
    expect(pd056(cwd, {})).toEqual([]);
    expect(pd056(cwd, config)).toEqual([]);
  });
});
