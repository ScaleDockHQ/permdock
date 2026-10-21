import { describe, expect, it } from "vitest";

import type { BetterSupabaseMembershipRow } from "../../src/better-supabase/index.ts";

import { principalFromMemberships } from "../../src/better-supabase/index.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  getPermDockSync,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  project: resource({
    id: "id",
    actions: ["read", "update"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { organization: { key: "organization_id" } },
  roles: [
    role("member", [allow(permissions.project.read)], { on: "organization" }),
    role("admin", [allow(permissions.project)], { on: "organization" }),
  ],
  subject: (principal: ReturnType<typeof principalFromMemberships>) =>
    principal,
});

const rows: readonly BetterSupabaseMembershipRow[] = [
  { user_id: "u1", organization_id: "o1", role: "admin", disabled_at: null },
  { user_id: "u1", organization_id: "o2", role: "member" },
  { user_id: "u1", organization_id: "o2", role: "member" },
  {
    user_id: "u1",
    organization_id: "o3",
    role: "admin",
    disabled_at: "2026-10-01T00:00:00Z",
  },
  { user_id: "u2", organization_id: "o4", role: "admin" },
];

describe("principalFromMemberships", () => {
  it("builds one membership per organization from the user's live rows", () => {
    expect(principalFromMemberships("u1", rows)).toEqual({
      id: "u1",
      memberships: [
        { scope: "tenant", id: "o1", roles: ["admin"] },
        { scope: "tenant", id: "o2", roles: ["member"] },
      ],
    });
  });

  it("keys the membership on the scope it is given", () => {
    const principal = principalFromMemberships("u1", rows, {
      scope: "organization",
    });
    expect(principal.memberships?.map((entry) => entry.scope)).toEqual([
      "organization",
      "organization",
    ]);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(principalFromMemberships("u1", rows))).toBe(true);
  });

  it("drops malformed rows", () => {
    const malformed = [
      { user_id: "u1", organization_id: "", role: "admin" },
      { user_id: "u1", organization_id: "o1", role: "" },
      null,
    ];
    // SAFETY: rows read from a database are untyped at run time; the helper must refuse these shapes.
    const principal = principalFromMemberships(
      "u1",
      malformed as unknown as readonly BetterSupabaseMembershipRow[],
    );
    expect(principal.memberships).toEqual([]);
  });

  it("grants the role of the active organization, and nothing in another", () => {
    const permdock = getPermDockSync(
      policy,
      principalFromMemberships("u1", rows, { tenant: "o1" }),
    );
    expect(
      permdock.can(permissions.project.update, {
        id: "p1",
        organization_id: "o1",
      }),
    ).toBe(true);
    expect(
      permdock.can(permissions.project.read, {
        id: "p2",
        organization_id: "o2",
      }),
    ).toBe(false);
  });

  it("holds only the member role in o2 and nothing in a disabled organization", () => {
    const permdock = getPermDockSync(
      policy,
      principalFromMemberships("u1", rows),
    );
    const o2 = { id: "p2", organization_id: "o2" };
    expect(permdock.tenant("o2").can(permissions.project.read, o2)).toBe(true);
    expect(permdock.tenant("o2").can(permissions.project.update, o2)).toBe(
      false,
    );
    expect(
      permdock
        .tenant("o3")
        .can(permissions.project.read, { id: "p3", organization_id: "o3" }),
    ).toBe(false);
  });

  it("denies every scoped check with no-tenant until an organization is active", () => {
    const decision = getPermDockSync(
      policy,
      principalFromMemberships("u1", rows),
    ).decide(permissions.project.update, { id: "p1", organization_id: "o1" });
    expect(decision.outcome).toBe("denied");
    expect(decision.outcome === "denied" && decision.denials).toContainEqual({
      role: "admin",
      reason: "no-tenant",
    });
  });
});
