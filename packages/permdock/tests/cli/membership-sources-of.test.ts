import { describe, expect, it } from "vitest";

import { membershipSourcesOf } from "../../src/cli/sql/sources.ts";
import { tableMembershipSource } from "../../src/supabase/index.ts";

describe("membershipSourcesOf", () => {
  const hook = tableMembershipSource({ table: "memberships" });
  const rls = tableMembershipSource({ table: "other_members" });

  it("prefers rls.membershipSources over the hook sources", () => {
    expect(
      membershipSourcesOf({
        policy: "p.ts",
        supabase: { hook: { memberships: [hook] } },
        rls: { membershipSources: [rls] },
      }),
    ).toStrictEqual([rls]);
  });

  it("falls back to the hook sources, then to none", () => {
    expect(
      membershipSourcesOf({
        policy: "p.ts",
        supabase: { hook: { memberships: [hook] } },
      }),
    ).toStrictEqual([hook]);
    expect(membershipSourcesOf({ policy: "p.ts" })).toStrictEqual([]);
  });
});
