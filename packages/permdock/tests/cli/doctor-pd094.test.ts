import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { pd094 } from "../../src/cli/doctor/better-supabase.ts";
import { junctionMembershipSource } from "../../src/supabase/index.ts";
import { policy } from "../fixtures/named-scopes.ts";

const through = { through: "roles", on: { role_id: "id" }, column: "key" };

const permdock: PermDockConfig = {
  policy: "p.ts",
  betterSupabase: { config: "better-supabase.config.ts" },
  rls: {
    memberships: {
      scopes: {
        organization: {
          table: "organization_users",
          user: "user_id",
          role: through,
          columns: { organization: "organization_id" },
        },
      },
    },
    suspension: {
      users: { table: "profiles", id: "user_id", disabledAt: "disabled_at" },
      scopes: {
        organization: {
          table: "organizations",
          id: "id",
          disabledAt: "closed_at",
        },
      },
    },
  },
  supabase: {
    hook: {
      memberships: [
        junctionMembershipSource({
          table: "organization_users",
          scope: "organization",
          roles: through,
        }),
      ],
    },
  },
};

const { policy: _path, ...withoutPolicy } = permdock;

const roles = '{ table: "public.roles", id: "id", column: "key" }';
const tenant =
  '{ table: "public.organizations", id: "id", disabledAt: "closed_at" }';
const user =
  '{ table: "public.profiles", id: "user_id", disabledAt: "disabled_at" }';

const dirs: string[] = [];

async function findings(
  body: string,
  config: PermDockConfig = permdock,
): Promise<readonly (string | undefined)[]> {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-pd094-"));
  dirs.push(cwd);
  writeFileSync(
    join(cwd, "better-supabase.config.ts"),
    `export default ${body};\n`,
  );
  const found = await pd094({
    cwd,
    config,
    policy: () => Promise.resolve(policy),
  });
  return found.map((finding) => finding.target);
}

describe("PD094", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports values better-supabase would fill from the provider", async () => {
    expect(
      await findings(`{
  blocks: {
    memberships: { options: { roleThrough: ${roles} } },
    permissions: { model: "provider", disabled: { tenant: ${tenant}, user: ${user} } },
  },
  platformRoles: { canAssign: "permdock_can_assign_any" },
}`),
    ).toStrictEqual([
      "blocks.memberships.options.roleThrough",
      "blocks.permissions.disabled.tenant",
      "blocks.permissions.disabled.user",
      "permdock_can_assign_any",
    ]);
  });

  it("builds the provider from the database manifest of a project without a hook", async () => {
    const { supabase: _supabase, ...hookless } = permdock;
    expect(
      await findings(
        `{ blocks: { memberships: { options: { roleThrough: ${roles} } }, permissions: { model: "provider", disabled: { user: ${user} } } } }`,
        { ...hookless, rls: { ...hookless.rls, authorize: "database" } },
      ),
    ).toStrictEqual([
      "blocks.memberships.options.roleThrough",
      "blocks.permissions.disabled.user",
    ]);
  });

  it("stays silent when the provider would not fill the value", async () => {
    expect(
      await findings(`{
  roleThrough: ${roles},
  blocks: {
    memberships: { options: { roleThrough: { table: "public.other_roles", id: "id", column: "key" } } },
    permissions: { disabled: { tenant: ${tenant}, user: ${user} } },
  },
}`),
    ).toStrictEqual([]);
    expect(
      await findings(`{
  blocks: {
    permissions: { model: "provider", disabled: { tenant: { table: "public.organizations", id: "id", disabledAt: "archived_at" } } },
  },
}`),
    ).toStrictEqual([]);
    expect(
      await findings(
        `{ blocks: { memberships: { options: { roleThrough: ${roles} } }, permissions: { model: "provider", disabled: { user: ${user} } } } }`,
        {
          policy: "p.ts",
          betterSupabase: { config: "better-supabase.config.ts" },
        },
      ),
    ).toStrictEqual([]);
    expect(
      await findings(
        `{ blocks: { permissions: { model: "provider", disabled: { user: ${user} } } } }`,
        withoutPolicy,
      ),
    ).toStrictEqual([]);
    expect(
      await findings('{ blocks: { permissions: { activeTenant: "claim" } } }'),
    ).toStrictEqual([]);
  });
});
