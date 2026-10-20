import { describe, expect, it } from "vitest";

import { subjectSettings } from "../../src/cli/rls/verify-pgtap.ts";

const subject = {
  dialect: "guc" as const,
  gucPrefix: "app",
  tenantClaim: "tenant_id",
  roleClaim: "user_role",
  customRoles: [],
  scopes: [],
};

describe("rls verify subject settings", () => {
  it("sets each fixture claim as a GUC, as withSubject does", () => {
    const settings = subjectSettings(
      {
        subject: {
          id: "u1",
          tenant: "acme",
          claims: {
            team_ids: ["blue"],
            region: "eu",
            user_id: "spoofed",
            "bad name": 1,
          },
        },
        action: "job.read",
        row: {},
      },
      subject,
    );
    expect(settings).toEqual([
      ["app.team_ids", '["blue"]'],
      ["app.region", "eu"],
      ["app.user_id", "u1"],
      ["app.user_role", ""],
      ["app.memberships", "[]"],
      ["app.tenant_id", "acme"],
    ]);
  });
});
