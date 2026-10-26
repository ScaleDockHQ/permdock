import { describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";
import type { CustomRole } from "../../src/index.ts";

import { CUSTOM_ROLE } from "../../src/cli/powersync/names.ts";
import { localRows } from "../../src/cli/powersync/rows.ts";
import { powersyncPlan } from "../../src/cli/powersync/streams.ts";
import { warnedFor } from "../../src/cli/powersync/verify-gaps.ts";
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

const permissions = definePermissions({
  job: resource({
    id: "id",
    actions: ["read"],
    relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "tenant_id" } },
  subject: () => null,
  roles: [
    role("owner", [allow(permissions.job.read)], { on: "tenant" }),
    role("viewer", [allow(permissions.job.read)], {
      on: "tenant",
      for: ["contact"],
    }),
  ],
});

const contacts = junctionMembershipSource({
  table: "contacts",
  scope: "tenant",
  id: "tenant_id",
  user: { through: "accounts", on: { account_id: "id" }, column: "user_id" },
  roles: ["viewer"],
  via: "contact",
});
const plans = junctionMembershipSource({
  table: "plans",
  scope: "tenant",
  id: "tenant_id",
  roles: { column: "tier", map: { business: "owner", free: null } },
});
const paused = junctionMembershipSource({
  table: "paused",
  scope: "tenant",
  id: "tenant_id",
  roles: "role",
  disabledAt: "paused_at",
});

const config: PermDockConfig = {
  policy: "p.ts",
  rls: {
    authorize: "database",
    customRoles: true,
    tables: { job: "jobs" },
    membershipSources: [contacts, plans, paused],
  },
};

describe("powersync over membership source shapes", () => {
  const plan = powersyncPlan(policy, config);

  it("compiles a role map, fixed roles and a user read through another table", () => {
    expect(plan.streams.find((stream) => stream.name === "job")).toMatchObject({
      queries: [
        "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT plans.tenant_id FROM plans WHERE plans.user_id = auth.user_id() AND plans.tier = 'business')",
        "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT paused.tenant_id FROM paused WHERE paused.user_id = auth.user_id() AND paused.paused_at IS NULL AND paused.role = 'owner')",
        "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT contacts.tenant_id FROM contacts INNER JOIN accounts ON accounts.id = contacts.account_id WHERE accounts.user_id = auth.user_id())",
        "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT paused.tenant_id FROM paused INNER JOIN \"permdock\".\"custom_role_permissions\" AS cr ON cr.role = paused.role WHERE paused.user_id = auth.user_id() AND paused.paused_at IS NULL AND cr.tenant_id = paused.tenant_id AND cr.scope = 'tenant' AND cr.permission = 'job.read' AND cr.effect = 'allow' AND cr.level IS NULL)",
      ],
    });
  });

  it("filters disabledAt sources without a suspension gap", () => {
    expect(plan.warnings).toStrictEqual([
      "custom role/job.read: a custom role's deny rows, includes and shared roles do not change its stream; the device still applies them",
    ]);
    expect(plan.unsynced).toStrictEqual([
      { permission: "job.read", role: CUSTOM_ROLE, composed: true },
    ]);
    expect(
      plan.subject.find((stream) => stream.table === "paused")?.queries,
    ).toStrictEqual([
      "SELECT * FROM paused WHERE paused.user_id = auth.user_id() AND paused.paused_at IS NULL",
    ]);
  });

  it("describes each source's rows for the device", () => {
    expect(localRows(policy, config, plan.devices).memberships).toStrictEqual([
      {
        table: "contacts",
        user: {
          column: "account_id",
          through: { table: "accounts", id: "id", column: "user_id" },
        },
        scope: { value: "tenant" },
        id: "tenant_id",
        roles: { value: ["viewer"] },
        via: { value: "contact" },
      },
      {
        table: "plans",
        user: { column: "user_id" },
        scope: { value: "tenant" },
        id: "tenant_id",
        roles: [{ column: "tier", map: { business: "owner", free: null } }],
      },
      {
        table: "paused",
        user: { column: "user_id" },
        scope: { value: "tenant" },
        id: "tenant_id",
        roles: [{ column: "role" }],
        disabledAt: "paused_at",
      },
    ]);
  });

  it("filters a scoped table source by its role sources and kinds", () => {
    const memberships = tableMembershipSource({
      table: "memberships",
      columns: {
        role: [
          "role",
          { column: "tier", map: { gold: "owner", platinum: "owner" } },
        ],
        via: "kind",
      },
    });
    const scoped = powersyncPlan(policy, {
      policy: "p.ts",
      rls: { tables: { job: "jobs" }, membershipSources: [memberships] },
    });
    expect(
      scoped.streams.find((stream) => stream.name === "job")?.queries,
    ).toStrictEqual([
      "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT memberships.scope_id FROM memberships WHERE memberships.user_id = auth.user_id() AND memberships.scope = 'tenant' AND memberships.role = 'owner')",
      "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT memberships.scope_id FROM memberships WHERE memberships.user_id = auth.user_id() AND memberships.scope = 'tenant' AND (memberships.tier = 'gold' OR memberships.tier = 'platinum'))",
      "SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT memberships.scope_id FROM memberships WHERE memberships.user_id = auth.user_id() AND memberships.scope = 'tenant' AND memberships.kind = 'contact' AND memberships.role = 'viewer')",
    ]);
  });

  it("lists a table source two scopes read once for the device", () => {
    const nested = definePermissions({
      job: resource({
        id: "id",
        actions: ["read"],
        relations: { team: { field: "team_id", memberOf: "team" } },
      }),
    });
    const teams = definePolicy(nested, {
      scopes: {
        tenant: { key: "tenant_id" },
        team: { key: "team_id", within: "tenant" },
      },
      subject: () => null,
      roles: [role("lead", [allow(nested.job.read)], { on: "team" })],
    });
    const shared: PermDockConfig = {
      policy: "p.ts",
      rls: {
        tables: { job: "jobs" },
        membershipSources: [tableMembershipSource({ table: "memberships" })],
      },
    };
    const rows = localRows(teams, shared, powersyncPlan(teams, shared).devices);
    expect(rows.memberships.map((source) => source.table)).toStrictEqual([
      "memberships",
    ]);
  });

  it("describes an rls.memberships table with a role map and a via column", () => {
    const table: PermDockConfig = {
      policy: "p.ts",
      rls: {
        tables: { job: "jobs" },
        memberships: {
          scopes: {
            tenant: {
              table: "members",
              user: "user_id",
              role: { column: "tier", map: { gold: "owner" } },
              via: "kind",
              columns: { tenant: "tenant_id" },
            },
          },
        },
      },
    };
    const members = powersyncPlan(policy, table);
    expect(localRows(policy, table, members.devices).memberships).toStrictEqual(
      [
        {
          table: "members",
          user: { column: "user_id" },
          scope: { value: "tenant" },
          id: "tenant_id",
          roles: [{ column: "tier", map: { gold: "owner" } }],
          via: { column: "kind" },
        },
      ],
    );
    const viaOf = (via?: { readonly value: string }) => {
      const target: PermDockConfig = {
        policy: "p.ts",
        rls: {
          tables: { job: "jobs" },
          memberships: {
            scopes: {
              tenant: {
                table: "members",
                user: "user_id",
                role: "role",
                ...(via === undefined ? {} : { via }),
                columns: { tenant: "tenant_id" },
              },
            },
          },
        },
      };
      return localRows(policy, target, new Map()).memberships[0]?.via;
    };
    expect(viaOf({ value: "staff" })).toStrictEqual({ value: "staff" });
    expect(viaOf()).toBeUndefined();
    const unkeyed: PermDockConfig = {
      policy: "p.ts",
      rls: {
        tables: { job: "jobs" },
        memberships: {
          scopes: {
            tenant: { table: "members", user: "user_id", role: "role" },
          },
        },
      },
    };
    expect(localRows(policy, unkeyed, new Map()).memberships).toStrictEqual([]);
  });
});

describe("warnedFor with sparse custom roles", () => {
  const subject = { id: "u1", roles: ["dispatch"] };
  const bare: CustomRole = { name: "dispatch", tenant: "t1", scope: "tenant" };
  const levelled: CustomRole = {
    name: "dispatch",
    tenant: "t1",
    scope: "tenant",
    grants: [{ permission: "job.read" }],
  };

  it("matches no gap for a custom role with no grants or includes", () => {
    expect(
      warnedFor(
        [
          { permission: "job.read", role: CUSTOM_ROLE },
          { permission: "job.read", role: CUSTOM_ROLE, composed: true },
        ],
        "job.read",
        subject,
        [bare],
      ),
    ).toBe(false);
  });

  it("reads a grant with no effect as allow and no level as the null level", () => {
    expect(
      warnedFor(
        [{ permission: "job.read", role: CUSTOM_ROLE, level: null }],
        "job.read",
        subject,
        [levelled],
      ),
    ).toBe(true);
    expect(
      warnedFor(
        [{ permission: "job.read", role: CUSTOM_ROLE, level: "own" }],
        "job.read",
        subject,
        [levelled],
      ),
    ).toBe(false);
  });
});
