import { describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { POSTGRES, powersyncPlan } from "../../src/cli/powersync/streams.ts";
import {
  allow,
  authenticated,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
  sqlFunction,
} from "../../src/index.ts";
import { junctionMembershipSource } from "../../src/supabase/index.ts";

const permissions = definePermissions({
  job: resource({
    id: "id",
    actions: ["read"],
    relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
    levels: { own: { owner_id: principal.id } },
  }),
});
const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "tenant_id" } },
  subject: () => null,
  roles: [
    role("owner", [allow(permissions.job.read)], {
      on: "tenant",
      assignable: true,
    }),
  ],
});

function configOf(
  keep: boolean,
  mapped = false,
  expires = false,
): PermDockConfig {
  return {
    policy: "p.ts",
    rls: {
      authorize: "database",
      customRoles: true,
      tables: { job: "jobs" },
      suspension: { memberships: { keep: keep ? [permissions.job.read] : [] } },
      ...(mapped
        ? {
            memberships: {
              scopes: {
                tenant: {
                  table: "members",
                  user: "user_id",
                  role: "role",
                  disabledAt: "disabled_at",
                  columns: { tenant: "tenant_id" },
                  ...(expires ? { expiresAt: "expires_at" } : {}),
                },
              },
            },
          }
        : {
            membershipSources: [
              junctionMembershipSource({
                table: "members",
                scope: "tenant",
                id: "tenant_id",
                roles: "role",
                disabledAt: "disabled_at",
                ...(expires ? { expiresAt: "expires_at" } : {}),
              }),
            ],
          }),
    },
  };
}

describe("powersync suspension", () => {
  it("filters joined users and referenced role rows with the membership column", () => {
    const config = configOf(false);
    const plan = powersyncPlan(policy, {
      ...config,
      rls: {
        ...config.rls,
        membershipSources: [
          junctionMembershipSource({
            table: "members",
            scope: "tenant",
            id: "tenant_id",
            user: {
              through: "accounts",
              on: { account_id: "id" },
              column: "user_id",
            },
            roles: { through: "roles", on: { role_id: "id" }, column: "key" },
            disabledAt: "disabled_at",
          }),
        ],
      },
    });
    expect(
      plan.subject.find((stream) => stream.table === "members")?.queries,
    ).toStrictEqual([
      "SELECT members.* FROM members INNER JOIN accounts ON accounts.id = members.account_id WHERE accounts.user_id = auth.user_id() AND members.disabled_at IS NULL",
    ]);
    expect(
      plan.subject.find((stream) => stream.table === "roles")?.queries,
    ).toStrictEqual([
      "SELECT * FROM roles WHERE roles.id IN (SELECT members.role_id FROM members INNER JOIN accounts ON accounts.id = members.account_id WHERE accounts.user_id = auth.user_id() AND members.disabled_at IS NULL)",
    ]);
  });

  it("applies keep to nested membership conditions without keeping another permission", () => {
    const where = sqlFunction("member", {
      twin: {
        op: "and",
        conditions: [
          {
            op: "memberOf",
            scope: "tenant",
            field: "tenant_id",
            roles: ["owner"],
          },
        ],
      },
    });
    const conditional = definePolicy(permissions, {
      scopes: { tenant: { key: "tenant_id" } },
      subject: () => null,
      grants: [allow(permissions.job.read, { to: authenticated(), where })],
    });
    for (const keep of [false, true]) {
      const config = configOf(keep);
      const plan = powersyncPlan(conditional, config);
      expect(plan.streams[0]?.queries).toStrictEqual([
        `SELECT * FROM jobs WHERE jobs.tenant_id IN (SELECT members.tenant_id FROM members WHERE members.user_id = auth.user_id()${keep ? "" : " AND members.disabled_at IS NULL"} AND members.role = 'owner')`,
      ]);
    }
    const config = configOf(false);
    const unrelated = powersyncPlan(policy, {
      ...config,
      rls: {
        ...config.rls,
        suspension: { memberships: { keep: ["other.read"] } },
      },
    });
    expect(
      unrelated.streams[0]?.queries.every((query) =>
        query.includes("members.disabled_at IS NULL"),
      ),
    ).toBe(true);
  });
  for (const mapped of [false, true]) {
    for (const keep of [false, true]) {
      it(`filters suspended memberships in ${mapped ? "mapped tables" : "sources"}, keep=${String(keep)}`, () => {
        for (const dialect of [undefined, POSTGRES]) {
          const plan = powersyncPlan(policy, configOf(keep, mapped), dialect);
          const queries = plan.streams[0]?.queries ?? [];
          expect(queries.length).toBeGreaterThan(0);
          for (const query of queries) {
            expect(/members.disabled_at(?:::text)? IS NULL/u.test(query)).toBe(
              !keep,
            );
          }
          const own = plan.subject.find((stream) => stream.table === "members");
          expect(own?.queries.length).toBeGreaterThan(0);
          expect(
            own?.queries.every((query) =>
              /members.disabled_at(?:::text)? IS NULL/u.test(query),
            ),
          ).toBe(!keep);
          if (!mapped) {
            expect(queries.some((query) => query.includes("cr.level"))).toBe(
              true,
            );
          }
          expect(plan.warnings.join("\n")).not.toContain("has disabledAt");
        }
      });
    }
    it(`retains expiry gaps for ${mapped ? "mapped tables" : "sources"}, even with keep`, () => {
      const plan = powersyncPlan(policy, configOf(true, mapped, true));
      expect(plan.streams).toStrictEqual([]);
      expect(plan.warnings.join("\n")).toMatch(/expiry/u);
    });
  }
});
