import { describe, expect, it } from "vitest";

import { subjectFromBetterSupabase } from "../../src/better-supabase/index.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const session = (claims: Record<string, unknown>) => ({
  kind: "user",
  claims: { sub: USER, role: "authenticated", ...claims },
});

describe("subjectFromBetterSupabase", () => {
  it("reads memberships and the features claim as plans", () => {
    const subject = subjectFromBetterSupabase(
      session({
        tenant_id: ORG,
        memberships: [{ scope: "organization", id: ORG, roles: ["owner"] }],
        features: { [ORG]: ["exports"] },
      }),
    );
    expect(subject.principal).toMatchObject({
      id: USER,
      tenant: ORG,
      plans: ["exports"],
      memberships: [{ scope: "organization", id: ORG, roles: ["owner"] }],
    });
  });

  it("lets options override the defaults", () => {
    const subject = subjectFromBetterSupabase(
      session({ tenant_id: ORG, plans: { [ORG]: ["pro"] } }),
      { plans: "plans" },
    );
    expect(subject.principal).toMatchObject({ plans: ["pro"] });
  });

  it("is anonymous without a user session", () => {
    expect(subjectFromBetterSupabase(null).principal).toBeNull();
    expect(subjectFromBetterSupabase({ kind: "anon" }).principal).toBeNull();
  });
});
