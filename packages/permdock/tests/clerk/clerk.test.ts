import { describe, expect, it } from "vitest";
import { z } from "zod";

import { subjectFromClerk } from "../../src/clerk/index.ts";
import { plan } from "../../src/core/grantee.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";

const permissions = definePermissions({
  billing: resource(z.object({ id: z.string() }), {
    id: "id",
    actions: ["create"],
  }),
});

const authObject = {
  userId: "user_1",
  orgId: "org_1",
  orgRole: "org:admin",
  orgPermissions: ["org:invoices:create", "org:unknown"],
  sessionId: "sess_1",
  sessionClaims: {
    sub: "user_1",
    sid: "sess_1",
    exp: 1_800_000_000,
    pla: "o:pro",
    fea: "o:reporting,u:api_access",
    plan: "pro",
    unsafeMetadata: { role: "superadmin" },
  },
  has: () => false,
};

describe("subjectFromClerk", () => {
  it("never throws and fails closed to anonymous", async () => {
    await expect(subjectFromClerk(null)).resolves.toMatchObject({
      principal: null,
    });
    await expect(subjectFromClerk(undefined)).resolves.toMatchObject({
      principal: null,
    });
    await expect(subjectFromClerk({ userId: "user_x" })).resolves.toMatchObject(
      {
        principal: null,
      },
    );
  });

  it("maps the Clerk auth object to a tenant-scoped subject", async () => {
    const subject = await subjectFromClerk(authObject, {
      permissions: {
        "org:invoices:create": permissions.billing.create,
      },
      features: { reporting: "reporting", api_access: "api" },
    });
    expect(subject.principal?.id).toBe("user_1");
    expect(subject.principal?.tenant).toBe("org_1");
    expect(subject.principal?.memberships).toEqual([
      {
        tenant: "org_1",
        roles: ["org:admin", "org:invoices:create", "reporting"],
        entitlements: ["pro"],
      },
    ]);
    expect(subject.principal?.clerkPermissions).toEqual([
      "org:invoices:create",
      "org:unknown",
    ]);
    expect(subject.principal?.roles).toEqual(["api"]);
    expect(subject.principal?.plans).toBeUndefined();
    expect(subject.principal?.featureSources).toEqual({
      reporting: "o",
      api: "u",
    });
    expect(subject.session).toBe("sess_1");
    expect(subject.expiresAt).toBe(1_800_000_000);
    expect(subject.principal?.claims).toMatchObject({ plan: "pro" });
    expect(subject.principal?.claims).not.toHaveProperty("unsafeMetadata");
  });

  it("loads every organization membership through the Backend API", async () => {
    const subject = await subjectFromClerk(authObject, {
      memberships: "all",
      backend: {
        users: {
          getOrganizationMembershipList: async () => ({
            data: [
              { organization: { id: "org_1" }, role: "org:admin" },
              { organization: { id: "org_2" }, role: "org:member" },
            ],
          }),
        },
      },
    });
    expect(subject.principal?.memberships).toEqual([
      { tenant: "org_1", roles: ["org:admin"], entitlements: ["pro"] },
      { tenant: "org_2", roles: ["org:member"] },
    ]);
  });

  it("maps a verified session payload and globalRoles from a claim path", async () => {
    const subject = await subjectFromClerk(
      {
        sub: "user_2",
        sid: "sess_2",
        org_id: "org_9",
        org_role: "org:member",
        publicMetadata: { staff: "reviewer" },
      },
      { globalRoles: "publicMetadata.staff" },
    );
    expect(subject.principal?.id).toBe("user_2");
    expect(subject.principal?.tenant).toBe("org_9");
    expect(subject.principal?.roles).toEqual(["reviewer"]);
    expect(subject.principal?.memberships).toEqual([
      { tenant: "org_9", roles: ["org:member"] },
    ]);
  });

  it("maps a session token v2 payload with the compact o claim", async () => {
    const subject = await subjectFromClerk(
      {
        v: 1,
        sub: "user_3",
        sid: "sess_3",
        exp: 1_800_000_000,
        fea: "o:invoices,u:api_access,o:reports",
        o: {
          id: "org_7",
          rol: "admin",
          slg: "acme",
          per: "create,read,manage",
          fpm: "3,6",
        },
      },
      { permissions: { "org:invoices:create": permissions.billing.create } },
    );
    expect(subject.principal?.tenant).toBe("org_7");
    expect(subject.principal?.clerkPermissions).toEqual([
      "org:invoices:create",
      "org:invoices:read",
      "org:reports:read",
      "org:reports:manage",
    ]);
    expect(subject.principal?.memberships).toEqual([
      { tenant: "org_7", roles: ["org:admin", "org:invoices:create"] },
    ]);
    expect(subject.principal?.claims).toBeUndefined();
  });

  it("pages through every Backend API membership for the user only", async () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({
      organization: { id: `org_${index}` },
      role: "org:member",
      publicUserData: { userId: index === 249 ? "user_other" : "user_1" },
    }));
    const pages: unknown[] = [];
    const subject = await subjectFromClerk(authObject, {
      memberships: "all",
      backend: {
        users: {
          getOrganizationMembershipList: async (args) => {
            pages.push(args);
            const offset = args.offset ?? 0;
            const limit = args.limit ?? 10;
            return {
              data: rows.slice(offset, offset + limit),
              totalCount: rows.length,
            };
          },
        },
      },
    });
    expect(pages).toEqual([
      { userId: "user_1", limit: 100, offset: 0 },
      { userId: "user_1", limit: 100, offset: 100 },
      { userId: "user_1", limit: 100, offset: 200 },
    ]);
    const tenants = subject.principal?.memberships?.map((item) => item.tenant);
    expect(tenants).toHaveLength(249);
    expect(tenants).not.toContain("org_249");
  });

  it("returns anonymous when userId is null", async () => {
    const subject = await subjectFromClerk({
      userId: null,
      sessionClaims: { sid: "sess" },
      has: () => false,
    });
    expect(subject.principal).toBeNull();
  });

  it("drops custom claims when the schema fails", async () => {
    const subject = await subjectFromClerk(authObject, {
      schema: z.object({ plan: z.number() }),
    });
    expect(subject.principal?.id).toBe("user_1");
    expect(subject.principal?.claims).toBeUndefined();
  });

  it("drops undeclared organization roles", async () => {
    const subject = await subjectFromClerk(authObject, {
      declared: ["org:member"],
    });
    expect(subject.principal?.memberships).toEqual([
      { tenant: "org_1", roles: [], entitlements: ["pro"] },
    ]);
  });

  it("treats a thrown Backend API call as no extra memberships", async () => {
    const subject = await subjectFromClerk(authObject, {
      memberships: "all",
      backend: {
        users: {
          getOrganizationMembershipList: async () => {
            throw new Error("down");
          },
        },
      },
    });
    expect(subject.principal?.memberships).toEqual([
      { tenant: "org_1", roles: ["org:admin"], entitlements: ["pro"] },
    ]);
  });

  it("scopes organization plans and features to the session organization", async () => {
    const tree = definePermissions({
      report: resource(z.object({ id: z.string() }), {
        id: "id",
        actions: ["export"],
      }),
    });
    const policy = definePolicy(tree, {
      roles: [
        role("reporting", [allow(tree.report.export)]),
        role("org:member", []),
      ],
      grants: [allow(tree.report.export, { to: plan("pro") })],
      subject: (user: Awaited<ReturnType<typeof subjectFromClerk>> | null) =>
        user?.principal ?? null,
    });
    const subject = await subjectFromClerk(
      { ...authObject, orgRole: "org:member" },
      {
        features: { reporting: "reporting" },
        memberships: "all",
        backend: {
          users: {
            getOrganizationMembershipList: async () => ({
              data: [
                { organization: { id: "org_1" }, role: "org:member" },
                { organization: { id: "org_2" }, role: "org:member" },
              ],
            }),
          },
        },
      },
    );
    expect(subject.principal?.plans).toBeUndefined();
    expect(subject.principal?.roles ?? []).not.toContain("reporting");
    expect(subject.principal?.memberships?.[0]).toEqual({
      tenant: "org_1",
      roles: ["org:member", "reporting"],
      entitlements: ["pro"],
    });
    const inA = await createPermDock(policy, subject);
    expect(inA.can(tree.report.export, { id: "r1" })).toBe(true);
    const inB = await createPermDock(policy, subject, { tenant: "org_2" });
    expect(inB.can(tree.report.export, { id: "r1" })).toBe(false);
  });
});
