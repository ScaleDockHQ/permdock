import { describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";
import type { SqlMembershipSource } from "../../src/supabase/index.ts";

import {
  powersyncPlan,
  powersyncYaml,
} from "../../src/cli/powersync/streams.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import {
  junctionMembershipSource,
  tableMembershipSource,
} from "../../src/supabase/index.ts";

const Row = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  job: resource(Row, {
    id: "id",
    actions: ["read"],
    relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
  }),
});
const { job } = permissions;

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "tenant_id" } },
  // SAFETY: stream generation never calls the subject mapper.
  subject: (user: unknown) => user as never,
  roles: [
    role("owner", [allow(job.read)], { on: "tenant" }),
    role("staff", [allow(job.read)], { on: "tenant", for: ["staff"] }),
    role("contact", [allow(job.read)], { on: "tenant", for: ["contact"] }),
  ],
});

const tier = junctionMembershipSource({
  table: "tenant_users",
  scope: "tenant",
  id: "tenant_id",
  roles: "tier_role",
  via: "staff",
});
const assigned = junctionMembershipSource({
  table: "user_roles",
  scope: "tenant",
  id: "tenant_id",
  roles: { through: "roles", on: { role_id: "id" }, column: "key" },
});

function configOf(
  sources: readonly SqlMembershipSource[],
  rls: PermDockConfig["rls"] = {},
): PermDockConfig {
  return {
    policy: "p.ts",
    rls: { tables: { job: "jobs" }, ...rls, membershipSources: sources },
  };
}

function jobQueries(target: PermDockConfig): readonly string[] {
  return (
    powersyncPlan(policy, target).streams.find(
      (stream) => stream.name === "job",
    )?.queries ?? []
  );
}

describe("powersync streams over membership sources", () => {
  it("unions one IN (SELECT …) per source that holds the role", () => {
    const queries = jobQueries(configOf([tier, assigned]));
    expect(queries).toContain(
      "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT tenant_users.tenant_id FROM tenant_users WHERE tenant_users.user_id = auth.user_id() AND tenant_users.tier_role = 'owner')",
    );
    expect(queries).toContain(
      "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT user_roles.tenant_id FROM user_roles INNER JOIN roles ON roles.id = user_roles.role_id WHERE user_roles.user_id = auth.user_id() AND roles.key = 'owner')",
    );
  });

  it("matches a role column by equality, so a row whose role is null grants nothing", () => {
    const queries = jobQueries(configOf([tier]));
    const owner = queries.filter((query) => query.includes("tier_role"));
    expect(
      owner.every((query) => /\.tier_role = '[a-z]+'\)$/u.test(query)),
    ).toBe(true);
    expect(queries.join("\n")).not.toMatch(/coalesce|IS NULL/u);
  });

  it("matches a fixed via against the role's kinds statically", () => {
    const queries = jobQueries(configOf([tier]));
    expect(queries.filter((query) => query.includes("'staff'"))).toStrictEqual([
      "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT tenant_users.tenant_id FROM tenant_users WHERE tenant_users.user_id = auth.user_id() AND tenant_users.tier_role = 'staff')",
    ]);
    expect(queries.join("\n")).not.toContain("'contact'");
  });

  it("filters a via column on the role's kinds", () => {
    const members = tableMembershipSource({
      table: "members",
      columns: { via: "kind" },
    });
    expect(jobQueries(configOf([members]))).toContain(
      "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT members.scope_id FROM members WHERE members.user_id = auth.user_id() AND members.scope = 'tenant' AND members.kind = 'contact' AND members.role = 'contact')",
    );
  });

  it("syncs a fixed-role source to the roles it holds", () => {
    const contacts = junctionMembershipSource({
      table: "customer_contacts",
      scope: "tenant",
      id: "tenant_id",
      roles: ["contact"],
      via: "contact",
    });
    expect(jobQueries(configOf([contacts]))).toStrictEqual([
      "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT customer_contacts.tenant_id FROM customer_contacts WHERE customer_contacts.user_id = auth.user_id())",
    ]);
  });

  it("under-syncs a source with an expiry and names it, and keeps the others", () => {
    const expiring = junctionMembershipSource({
      table: "grants",
      scope: "tenant",
      id: "tenant_id",
      roles: "role",
      expiresAt: "expires_at",
    });
    const plan = powersyncPlan(policy, configOf([expiring, assigned]));
    expect(plan.warnings).toContain(
      "owner/job.read under-syncs: the public.grants membership source has no stream: it has an expiry",
    );
    expect(plan.streams[0]?.queries.join("\n")).toContain("user_roles");
    expect(plan.streams[0]?.queries.join("\n")).not.toContain("grants");
  });

  it("under-syncs a hand-written source and names its table", () => {
    const { stream: _stream, ...sql } = tier.sql;
    const handWritten: SqlMembershipSource = { ...tier, sql };
    const plan = powersyncPlan(policy, configOf([handWritten]));
    expect(plan.warnings).toContain(
      "owner/job.read under-syncs: the tenant_users membership source has no stream form: build it with tableMembershipSource or junctionMembershipSource",
    );
    expect(plan.omitted).toStrictEqual([
      { resource: "job", reason: "no grant of job.read compiles" },
    ]);
  });

  it("reads a guarded roles table as no role on a tenant row named like a declared role", () => {
    const queries = jobQueries(
      configOf([assigned], {
        authorize: "database",
        customRoles: true,
        customRoleWrites: {
          roles: {
            table: "roles",
            key: "key",
            tenant: "tenant_id",
            skip: "is_system",
          },
        },
      }),
    );
    expect(queries).toContain(
      "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT user_roles.tenant_id FROM user_roles INNER JOIN roles ON roles.id = user_roles.role_id WHERE user_roles.user_id = auth.user_id() AND roles.key = 'owner' AND (roles.tenant_id IS NULL OR roles.is_system = true))",
    );
  });

  it("streams each source's own rows, its roles table and the tenant custom roles", () => {
    const plan = powersyncPlan(
      policy,
      configOf([tier, assigned], { authorize: "database", customRoles: true }),
    );
    expect(plan.subject).toStrictEqual([
      {
        name: "permdock_tenant_users",
        table: "tenant_users",
        user: "user_id",
        queries: [
          "SELECT * FROM tenant_users WHERE tenant_users.user_id = auth.user_id()",
        ],
      },
      {
        name: "permdock_user_roles",
        table: "user_roles",
        user: "user_id",
        queries: [
          "SELECT * FROM user_roles WHERE user_roles.user_id = auth.user_id()",
        ],
      },
      {
        name: "permdock_roles",
        table: "roles",
        queries: [
          "SELECT * FROM roles WHERE roles.id IN (SELECT user_roles.role_id FROM user_roles WHERE user_roles.user_id = auth.user_id())",
        ],
      },
      {
        name: "permdock_permdock_user_roles",
        table: "permdock_user_roles",
        user: "user_id",
        queries: expect.any(Array),
      },
      {
        name: "permdock_custom_role_permissions",
        table: "custom_role_permissions",
        queries: [
          'SELECT * FROM "permdock"."custom_role_permissions" AS custom_role_permissions WHERE custom_role_permissions.tenant_id IS NULL',
          'SELECT * FROM "permdock"."custom_role_permissions" AS custom_role_permissions WHERE custom_role_permissions.tenant_id IN (SELECT tenant_users.tenant_id FROM tenant_users WHERE tenant_users.user_id = auth.user_id())',
          'SELECT * FROM "permdock"."custom_role_permissions" AS custom_role_permissions WHERE custom_role_permissions.tenant_id IN (SELECT user_roles.tenant_id FROM user_roles WHERE user_roles.user_id = auth.user_id())',
        ],
      },
      {
        name: "permdock_custom_role_includes",
        table: "custom_role_includes",
        queries: expect.any(Array),
      },
    ]);
  });

  it("states the publication of the synced tables outside public", () => {
    const plan = powersyncPlan(
      policy,
      configOf([assigned], { authorize: "database", customRoles: true }),
    );
    expect(plan.publication).toBe(
      "alter publication powersync add table permdock.custom_role_includes, permdock.custom_role_permissions, permdock.user_roles;",
    );
    expect(powersyncYaml(plan)).toContain(
      `      - 'SELECT * FROM "permdock"."custom_role_permissions" AS custom_role_permissions WHERE custom_role_permissions.tenant_id IS NULL'`,
    );
    expect(powersyncYaml(plan).split("\n").slice(0, 3)).toStrictEqual([
      "# Generated by permdock powersync generate from the policy. Do not edit.",
      "# Tables outside public must be in the powersync publication:",
      `# ${plan.publication ?? ""}`,
    ]);
    expect(
      powersyncPlan(policy, configOf([assigned])).publication,
    ).toBeUndefined();
  });
});
