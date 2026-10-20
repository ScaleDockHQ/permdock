import { describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { POSTGRES, powersyncPlan } from "../../src/cli/powersync/streams.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
  sqlFunction,
} from "../../src/index.ts";
import { junctionMembershipSource } from "../../src/supabase/index.ts";

const Row = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const inTeam = sqlFunction("permdock_in_team", {
  args: [{ field: "team_id" }],
  twin: { team_id: { in: { ref: "principal.claims.team_ids" } } },
});

function policyOf(team: unknown) {
  const permissions = definePermissions({
    job: resource(Row, {
      id: "id",
      actions: ["read"],
      relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
      levels: {
        own: { owner_id: principal.id },
        // SAFETY: a level is a portable where; the test passes a sqlFunction or an opaque condition.
        team: team as never,
        all: {},
      },
    }),
  });
  return definePolicy(permissions, {
    scopes: { tenant: { key: "tenant_id" } },
    // SAFETY: stream generation never calls the subject mapper.
    subject: (user: unknown) => user as never,
    roles: [
      role("owner", [allow(permissions.job.read)], {
        on: "tenant",
        assignable: true,
      }),
    ],
  });
}

const assigned = junctionMembershipSource({
  table: "user_roles",
  scope: "tenant",
  id: "tenant_id",
  roles: { through: "roles", on: { role_id: "id" }, column: "key" },
});
const tier = junctionMembershipSource({
  table: "tenant_users",
  scope: "tenant",
  id: "tenant_id",
  roles: "tier_role",
});

const config: PermDockConfig = {
  policy: "p.ts",
  rls: {
    authorize: "database",
    customRoles: true,
    tables: { job: "jobs" },
    membershipSources: [tier, assigned],
  },
};

function custom(level: string): string {
  return `jobs.tenant_id IN (SELECT user_roles.tenant_id FROM user_roles INNER JOIN roles ON roles.id = user_roles.role_id INNER JOIN "permdock"."custom_role_permissions" AS cr ON cr.role = roles.key WHERE user_roles.user_id = auth.user_id() AND cr.tenant_id = user_roles.tenant_id AND cr.scope = 'tenant' AND cr.permission = 'job.read' AND cr.effect = 'allow' AND ${level})`;
}

describe("powersync level-aware custom-role streams", () => {
  const plan = powersyncPlan(policyOf(inTeam), config);
  const queries = plan.streams[0]?.queries ?? [];

  it("syncs a custom role's allow with no level through each root-scope source", () => {
    expect(queries).toContain(
      `SELECT * FROM jobs WHERE ${custom("cr.level IS NULL")}`,
    );
    expect(queries).toContain(
      "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT tenant_users.tenant_id FROM tenant_users INNER JOIN \"permdock\".\"custom_role_permissions\" AS cr ON cr.role = tenant_users.tier_role WHERE tenant_users.user_id = auth.user_id() AND cr.tenant_id = tenant_users.tenant_id AND cr.scope = 'tenant' AND cr.permission = 'job.read' AND cr.effect = 'allow' AND cr.level IS NULL)",
    );
  });

  it("adds the own level's condition", () => {
    expect(queries).toContain(
      `SELECT * FROM jobs WHERE ${custom("cr.level = 'own'")} AND jobs.owner_id = auth.user_id()`,
    );
  });

  it("compiles a sqlFunction level through its twin", () => {
    expect(queries).toContain(
      `SELECT * FROM jobs WHERE ${custom("cr.level = 'team'")} AND jobs.team_id IN (SELECT value FROM json_each(auth.parameter('team_ids')))`,
    );
  });

  it("adds nothing for the all level", () => {
    expect(queries).toContain(
      `SELECT * FROM jobs WHERE ${custom("cr.level = 'all'")}`,
    );
  });

  it("warns that custom-role denies do not subtract", () => {
    expect(plan.warnings).toContain(
      "custom role/job.read: a custom role's deny rows, includes and shared roles do not change its stream; the device still applies them",
    );
  });

  it("names the level whose twin has no Sync Streams form", () => {
    const opaque = sqlFunction("permdock_in_team", {
      twin: { tags: { contains: "x" } },
    });
    const levelled = powersyncPlan(policyOf(opaque), config);
    expect(levelled.warnings).toContain(
      "custom role/job.read@team does not sync: its condition has no Sync Streams form",
    );
    expect(levelled.streams[0]?.queries.join("\n")).not.toContain("'team'");
  });

  it("writes the Postgres form verify runs", () => {
    const postgres = powersyncPlan(policyOf(inTeam), config, POSTGRES);
    expect(postgres.streams[0]?.queries.join("\n")).toContain(
      "cr.level::text = 'own'",
    );
  });

  it("needs database mode with custom roles and an assignable role", () => {
    const off = powersyncPlan(policyOf(inTeam), {
      ...config,
      rls: { ...config.rls, customRoles: false },
    });
    expect(off.streams[0]?.queries.join("\n")).not.toContain("custom_role");
  });
});
