import type { StandardSchemaV1 } from "@standard-schema/spec";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { subjectFromClerk } from "../../src/clerk/index.ts";

const has = (): boolean => false;

describe("subjectFromClerk claim parsing", () => {
  it("reads id, tenant, role and session from sessionClaims when the fields are absent", async () => {
    const subject = await subjectFromClerk({
      has,
      orgPermissions: null,
      sessionClaims: {
        sub: "user_1",
        sid: "sess_1",
        org_id: "org_1",
        org_role: "org:admin",
        org_permissions: "org:x:read",
      },
    });
    expect({
      id: subject.principal?.id,
      tenant: subject.principal?.tenant,
      session: subject.session,
      memberships: subject.principal?.memberships,
      clerkPermissions: subject.principal?.clerkPermissions,
    }).toEqual({
      id: "user_1",
      tenant: "org_1",
      session: "sess_1",
      memberships: [{ tenant: "org_1", roles: ["org:admin"] }],
      clerkPermissions: ["org:x:read"],
    });
  });

  it("is anonymous for an auth object without a user and for unverified payloads", async () => {
    const results = await Promise.all([
      subjectFromClerk({ has, sessionClaims: "claims" }),
      subjectFromClerk({ sub: "user_1" }),
      subjectFromClerk({ sub: "", sid: "s" }),
      subjectFromClerk(["user_1"]),
    ]);
    expect(results.map((subject) => subject.principal)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("accepts a payload identified by azp, org_id or the v2 o claim", async () => {
    const results = await Promise.all([
      subjectFromClerk({ sub: "u1", azp: "https://app.test" }),
      subjectFromClerk({ sub: "u2", org_id: "org_1", org_role: "org:member" }),
      subjectFromClerk({ sub: "u3", o: { id: "org_2", rol: "org:admin" } }),
    ]);
    expect(
      results.map((subject) => [
        subject.principal?.id,
        subject.principal?.memberships,
      ]),
    ).toEqual([
      ["u1", []],
      ["u2", [{ tenant: "org_1", roles: ["org:member"] }]],
      ["u3", [{ tenant: "org_2", roles: ["org:admin"] }]],
    ]);
  });

  it("skips bad v2 feature masks and empty role names", async () => {
    const subject = await subjectFromClerk({
      sub: "u1",
      fea: "o:reports,o:billing,o:audit",
      o: { id: "org_1", rol: "", per: "read,write", fpm: "3,-1,x" },
    });
    expect(subject.principal?.clerkPermissions).toEqual([
      "org:reports:read",
      "org:reports:write",
    ]);
  });

  it("splits plans and features by owner and skips blank tokens", async () => {
    const subject = await subjectFromClerk(
      {
        sub: "u1",
        sid: "s1",
        org_id: "org_1",
        pla: "o:team, ,u:pro,free",
        fea: "o:reports, ,u:api,plain,unknown",
      },
      { features: { reports: "reporter", api: "api-user", plain: "plain" } },
    );
    expect({
      plans: subject.principal?.plans,
      roles: subject.principal?.roles,
      memberships: subject.principal?.memberships,
      sources: subject.principal?.featureSources,
    }).toEqual({
      plans: ["pro", "free"],
      roles: ["api-user", "plain"],
      memberships: [
        { tenant: "org_1", roles: ["reporter"], entitlements: ["team"] },
      ],
      sources: { reporter: "o", "api-user": "u" },
    });
  });

  it("reads globalRoles from a function, a string claim and a missing path", async () => {
    const payload = {
      sub: "u1",
      sid: "s1",
      metadata: { role: "staff" },
    };
    const results = await Promise.all([
      subjectFromClerk(payload, { globalRoles: () => ["ops"] }),
      subjectFromClerk(payload, {
        globalRoles: () => {
          throw new Error("mapper failed");
        },
      }),
      subjectFromClerk(payload, { globalRoles: "metadata.role" }),
      subjectFromClerk(payload, { globalRoles: "metadata.missing.deep" }),
      subjectFromClerk(
        { ...payload, metadata: { role: "" } },
        {
          globalRoles: "metadata.role",
        },
      ),
    ]);
    expect(results.map((subject) => subject.principal?.roles)).toEqual([
      ["ops"],
      [],
      ["staff"],
      [],
      [],
    ]);
  });

  it("drops claims from an async or non-object schema result", async () => {
    const asyncSchema = z
      .object({ plan: z.string() })
      .transform(async (v) => v);
    const scalar: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ value: 1 }),
      },
    };
    const results = await Promise.all(
      [asyncSchema, scalar].map((schema) =>
        subjectFromClerk({ sub: "u1", sid: "s1", plan: "pro" }, { schema }),
      ),
    );
    expect(results.map((subject) => subject.principal?.claims)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("subjectFromClerk Backend memberships", () => {
  it("reads array pages, nested organizations and stops at totalCount", async () => {
    const calls: number[] = [];
    const subject = await subjectFromClerk(
      { sub: "u1", sid: "s1" },
      {
        memberships: "all",
        backend: {
          users: {
            getOrganizationMembershipList: async ({ offset }) => {
              calls.push(offset ?? -1);
              if (offset === 0) {
                return [
                  { organization: { id: "org_a" }, role: "org:member" },
                  { organization: {}, role: "org:member" },
                  { organizationId: "org_b", role: "" },
                  {
                    organizationId: "org_c",
                    role: "org:admin",
                    publicUserData: null,
                  },
                ];
              }
              return { data: [], totalCount: 0 };
            },
          },
        },
      },
    );
    const missing = await subjectFromClerk(
      { sub: "u1", sid: "s1" },
      { memberships: "all", backend: {} },
    );
    const weird = await subjectFromClerk(
      { sub: "u1", sid: "s1" },
      {
        memberships: "all",
        backend: {
          users: {
            getOrganizationMembershipList: async () =>
              // SAFETY: a malformed Backend API response the adapter must tolerate.
              "nope" as unknown as readonly [],
          },
        },
      },
    );
    expect({
      calls,
      memberships: subject.principal?.memberships,
      missing: missing.principal?.memberships,
      weird: weird.principal?.memberships,
    }).toEqual({
      calls: [0],
      memberships: [
        { tenant: "org_a", roles: ["org:member"] },
        { tenant: "org_c", roles: ["org:admin"] },
      ],
      missing: [],
      weird: [],
    });
  });
});
