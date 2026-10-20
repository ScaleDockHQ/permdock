import { describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";
import type { CustomRole } from "../../src/index.ts";

import { CUSTOM_ROLE } from "../../src/cli/powersync/names.ts";
import { powersyncPlan } from "../../src/cli/powersync/streams.ts";
import { warnedFor } from "../../src/cli/powersync/verify-gaps.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
} from "../../src/index.ts";
import { junctionMembershipSource } from "../../src/supabase/index.ts";

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
    levels: { own: { owner_id: principal.id }, all: {} },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "tenant_id" } },
  // SAFETY: stream generation never calls the subject mapper.
  subject: (user: unknown) => user as never,
  roles: [
    role("owner", [allow(permissions.job.read)], {
      on: "tenant",
      assignable: true,
    }),
    role("support", [allow(permissions.job.read)]),
  ],
});

const config: PermDockConfig = {
  policy: "p.ts",
  rls: {
    authorize: "database",
    customRoles: true,
    tables: { job: "jobs" },
    membershipSources: [
      junctionMembershipSource({
        table: "user_roles",
        scope: "tenant",
        id: "tenant_id",
        roles: "role",
        expiresAt: "expires_at",
      }),
    ],
  },
};

const tech: CustomRole = {
  name: "tech",
  tenant: "t1",
  scope: "tenant",
  grants: [{ permission: "job.read", effect: "allow", level: "own" }],
  includes: [],
};

describe("powersync unsynced grants", () => {
  const plan = powersyncPlan(policy, config);

  it("records the grant behind each warning", () => {
    expect(plan.unsynced).toEqual(
      expect.arrayContaining([
        { permission: "job.read", role: "owner" },
        { permission: "job.read", role: "support" },
        { permission: "job.read", role: CUSTOM_ROLE },
      ]),
    );
    expect(plan.warnings).toContain(
      "custom role/job.read does not sync: the public.user_roles membership source has no stream: it has an expiry",
    );
  });

  it("records a custom role's level and composition when its source syncs", () => {
    const synced = powersyncPlan(policy, {
      ...config,
      rls: {
        authorize: "database",
        customRoles: true,
        tables: { job: "jobs" },
        membershipSources: [
          junctionMembershipSource({
            table: "user_roles",
            scope: "tenant",
            id: "tenant_id",
            roles: "role",
          }),
        ],
      },
    });
    expect(synced.unsynced).toEqual([
      { permission: "job.read", role: "support" },
      { permission: "job.read", role: CUSTOM_ROLE, composed: true },
    ]);
  });

  it("excuses a subject holding the warned declared role", () => {
    expect(
      warnedFor(plan.unsynced, "job.read", { id: "u", roles: ["support"] }, []),
    ).toBe(true);
    expect(
      warnedFor(
        plan.unsynced,
        "job.read",
        {
          id: "u",
          memberships: [{ scope: "tenant", id: "t1", roles: ["owner"] }],
        },
        [],
      ),
    ).toBe(true);
    expect(warnedFor(plan.unsynced, "job.read", { id: "u" }, [])).toBe(false);
    expect(
      warnedFor(
        plan.unsynced,
        "job.update",
        { id: "u", roles: ["support"] },
        [],
      ),
    ).toBe(false);
  });

  it("excuses a custom role only at the warned level", () => {
    const subject = {
      id: "u",
      memberships: [{ scope: "tenant", id: "t1", roles: ["tech"] }],
    };
    const own = [{ permission: "job.read", role: CUSTOM_ROLE, level: "own" }];
    const none = [{ permission: "job.read", role: CUSTOM_ROLE, level: null }];
    expect(warnedFor(own, "job.read", subject, [tech])).toBe(true);
    expect(warnedFor(none, "job.read", subject, [tech])).toBe(false);
    expect(
      warnedFor(
        [{ permission: "job.read", role: CUSTOM_ROLE }],
        "job.read",
        subject,
        [tech],
      ),
    ).toBe(true);
    expect(warnedFor(own, "job.read", { id: "u" }, [tech])).toBe(false);
    expect(
      warnedFor(own, "job.read", subject, [
        { ...tech, grants: [{ permission: "job.read", level: "own" }] },
      ]),
    ).toBe(true);
  });

  it("excuses a composed custom role for the composition warning", () => {
    const composed = [
      { permission: "job.read", role: CUSTOM_ROLE, composed: true as const },
    ];
    const subject = {
      id: "u",
      memberships: [{ scope: "tenant", id: "t1", roles: ["tech"] }],
    };
    expect(warnedFor(composed, "job.read", subject, [tech])).toBe(false);
    expect(
      warnedFor(composed, "job.read", subject, [
        { ...tech, includes: ["owner"] },
      ]),
    ).toBe(true);
  });
});
