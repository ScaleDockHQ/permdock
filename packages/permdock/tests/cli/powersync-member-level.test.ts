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

function policyOf(levels: Record<string, unknown>) {
  const permissions = definePermissions({
    job: resource(Row, {
      id: "id",
      actions: ["read"],
      relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
      // SAFETY: a level is a portable where; the test passes plain, sqlFunction and opaque conditions.
      levels: levels as never,
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

const leveled = policyOf({
  own: { owner_id: principal.id },
  team: inTeam,
  all: {},
});

const tier = junctionMembershipSource({
  table: "tenant_users",
  scope: "tenant",
  id: "tenant_id",
  roles: "tier_role",
});

function configOf(memberLevel: unknown): PermDockConfig {
  return {
    policy: "p.ts",
    powersync: {
      resources: ["job"],
      // SAFETY: the test passes the documented shape and invalid ones.
      memberLevel: memberLevel as never,
    },
    rls: {
      authorize: "database",
      tables: { job: "jobs" },
      membershipSources: [tier],
    },
  };
}

const held =
  "jobs.tenant_id IN (SELECT tenant_users.tenant_id FROM tenant_users WHERE tenant_users.user_id = auth.user_id() AND tenant_users.tier_role = 'owner')";
function level(clause: string): string {
  return `jobs.tenant_id IN (SELECT tenant_users.tenant_id FROM tenant_users WHERE tenant_users.user_id = auth.user_id() AND ${clause})`;
}

const config = configOf({
  job: { table: "tenant_users", column: "job_level" },
});

describe("powersync powersync.memberLevel", () => {
  const plan = powersyncPlan(leveled, config);
  const queries = plan.streams[0]?.queries ?? [];

  it("syncs the whole tenant to a member with no level or the level all", () => {
    expect(queries).toContain(
      `SELECT * FROM jobs WHERE ${held} AND ${level("(tenant_users.job_level IS NULL OR tenant_users.job_level = 'all')")}`,
    );
  });

  it("syncs a member at the own level the rows the own level reaches", () => {
    expect(queries).toContain(
      `SELECT * FROM jobs WHERE ${held} AND ${level("tenant_users.job_level = 'own'")} AND jobs.owner_id = auth.user_id()`,
    );
  });

  it("syncs a member at the team level the rows the team level reaches", () => {
    expect(queries).toContain(
      `SELECT * FROM jobs WHERE ${held} AND ${level("tenant_users.job_level = 'team'")} AND jobs.team_id IN (SELECT value FROM json_each(auth.parameter('team_ids')))`,
    );
  });

  it("writes one query per level and no query for another value", () => {
    expect(queries).toHaveLength(3);
  });

  it("reads the team claim the level uses", () => {
    expect(plan.streams[0]?.claims).toContain("team_ids");
  });

  it("states the narrowing and excuses verify for the permission", () => {
    expect(plan.warnings).toContain(
      "job/job.read narrows by member level: a member whose tenant_users.job_level is own or team syncs the rows of that level only",
    );
    expect(plan.unsynced).toContainEqual({
      permission: "job.read",
      role: "anyone",
    });
  });

  it("writes the Postgres form verify runs", () => {
    const postgres = powersyncPlan(leveled, config, POSTGRES);
    expect(postgres.streams[0]?.queries.join("\n")).toContain(
      "tenant_users.job_level::text = 'own'",
    );
  });

  it("changes nothing for a resource without memberLevel", () => {
    const plain = powersyncPlan(leveled, configOf(undefined));
    expect(plain.streams[0]?.queries).toStrictEqual([
      `SELECT * FROM jobs WHERE ${held}`,
    ]);
    expect(plain.unsynced).toStrictEqual([]);
  });

  it("leaves a level out and says why when its condition has no Sync Streams form", () => {
    const opaque = sqlFunction("permdock_in_team", {
      twin: { tags: { contains: "x" } },
    });
    const narrowed = powersyncPlan(
      policyOf({ own: { owner_id: principal.id }, team: opaque }),
      config,
    );
    expect(narrowed.streams[0]?.queries.join("\n")).not.toContain("'team'");
    expect(narrowed.warnings).toContain(
      "job/job.read member level team does not sync: its condition has no Sync Streams form",
    );
  });

  it("omits the stream when the resource declares neither own nor team", () => {
    const omitted = powersyncPlan(policyOf({ all: {} }), config);
    expect(omitted.streams).toStrictEqual([]);
    expect(omitted.omitted).toContainEqual({
      resource: "job",
      reason: "memberLevel needs a level named own or team on job",
    });
  });

  it("omits the stream when no root-scope membership table is named", () => {
    const omitted = powersyncPlan(
      leveled,
      configOf({ job: { table: "elsewhere", column: "job_level" } }),
    );
    expect(omitted.streams).toStrictEqual([]);
    expect(omitted.omitted).toContainEqual({
      resource: "job",
      reason:
        "memberLevel table elsewhere is not a membership table of the tenant scope",
    });
  });

  it("rejects a column that is not an identifier", () => {
    expect(() =>
      powersyncPlan(
        leveled,
        configOf({ job: { table: "tenant_users", column: "x; drop" } }),
      ),
    ).toThrow(/memberLevel/u);
  });

  it("narrows through an rls.memberships table and keeps its suspension filter", () => {
    const table = powersyncPlan(leveled, {
      policy: "p.ts",
      powersync: {
        resources: ["job"],
        memberLevel: { job: { table: "tenant_users", column: "job_level" } },
      },
      rls: {
        authorize: "database",
        tables: { job: "jobs" },
        memberships: {
          scopes: {
            tenant: {
              table: "tenant_users",
              user: "user_id",
              role: "tier_role",
              columns: { tenant: "tenant_id" },
              disabledAt: "disabled_at",
            },
          },
        },
      },
    });
    expect(table.omitted).toStrictEqual([]);
    expect(table.streams[0]?.queries).toContain(
      "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT tenant_users.tenant_id FROM tenant_users WHERE tenant_users.user_id = auth.user_id() AND tenant_users.disabled_at IS NULL AND tenant_users.tier_role IN ('owner')) AND jobs.tenant_id IN (SELECT tenant_users.tenant_id FROM tenant_users WHERE tenant_users.user_id = auth.user_id() AND tenant_users.disabled_at IS NULL AND tenant_users.job_level = 'own') AND jobs.owner_id = auth.user_id()",
    );
  });

  it("omits the stream when the membership table of the scope is another one", () => {
    const other = powersyncPlan(leveled, {
      policy: "p.ts",
      powersync: {
        resources: ["job"],
        memberLevel: { job: { table: "elsewhere", column: "job_level" } },
      },
      rls: {
        authorize: "database",
        tables: { job: "jobs" },
        memberships: {
          scopes: {
            tenant: {
              table: "tenant_users",
              user: "user_id",
              role: "tier_role",
              columns: { tenant: "tenant_id" },
            },
          },
        },
      },
    });
    expect(other.omitted).toStrictEqual([
      {
        resource: "job",
        reason:
          "memberLevel table elsewhere is not a membership table of the tenant scope",
      },
    ]);
  });

  it("names a source a level's condition cannot read", () => {
    const { stream: _stream, ...sql } = tier.sql;
    const handWritten = { ...tier, sql: { ...sql, table: "legacy_users" } };
    const reading = powersyncPlan(
      policyOf({
        own: { owner_id: principal.id },
        team: {
          op: "memberOf",
          scope: "tenant",
          field: "tenant_id",
          roles: ["owner"],
        },
      }),
      {
        ...config,
        rls: { ...config.rls, membershipSources: [tier, handWritten] },
      },
    );
    expect(reading.warnings).toContain(
      "job/job.read member level team under-syncs: the legacy_users membership source has no stream form: build it with tableMembershipSource, junctionMembershipSource or blockMembershipSource",
    );
  });
});
