import { describe, expect, it } from "vitest";

import {
  decidingColumns,
  membershipColumns,
  tableKey,
} from "../../src/cli/sql/deciding-columns.ts";
import { tableMembershipSource } from "../../src/supabase/index.ts";

describe("tableKey", () => {
  it("qualifies, unquotes and lower-cases a table name", () => {
    expect(tableKey("Members")).toBe("public.members");
    expect(tableKey('"Auth"."Members"')).toBe("auth.members");
  });
});

describe("membershipColumns", () => {
  it("reads rls.membershipSources and the hook sources the claims come from", () => {
    const hook = tableMembershipSource({ table: "memberships" });
    const rls = tableMembershipSource({ table: "other_members" });
    const config = {
      policy: "p.ts",
      supabase: { hook: { memberships: [hook] } },
      rls: { membershipSources: [rls] },
    };
    expect([...membershipColumns(config).keys()]).toStrictEqual([
      "public.other_members",
      "public.memberships",
    ]);
  });

  it("counts a source both lists share once", () => {
    const shared = tableMembershipSource({ table: "memberships" });
    const config = {
      policy: "p.ts",
      supabase: { hook: { memberships: [shared] } },
      rls: { membershipSources: [shared] },
    };
    expect([
      ...(membershipColumns(config).get("public.memberships") ?? []),
    ]).toStrictEqual(shared.sql.columns);
  });

  it("falls back to rls.membershipSources, then to nothing", () => {
    const rls = tableMembershipSource({ table: "app.members" });
    expect([
      ...membershipColumns({
        policy: "p.ts",
        rls: { membershipSources: [rls] },
      }).keys(),
    ]).toStrictEqual(["app.members"]);
    expect(membershipColumns({ policy: "p.ts" }).size).toBe(0);
  });

  it("merges the columns of two sources on one table", () => {
    const a = tableMembershipSource({ table: "memberships" });
    const b = tableMembershipSource({ table: "public.memberships" });
    const columns = membershipColumns({
      policy: "p.ts",
      rls: { membershipSources: [a, b] },
    });
    expect(columns.size).toBe(1);
    expect([...(columns.get("public.memberships") ?? [])]).toStrictEqual([
      ...new Set([...a.sql.columns, ...b.sql.columns]),
    ]);
  });
});

describe("decidingColumns", () => {
  it("lists membership and attrs columns, sorted", () => {
    const source = tableMembershipSource({ table: "memberships" });
    const columns = decidingColumns(
      { policy: "p.ts", rls: { membershipSources: [source] } },
      { table: "profiles", columns: ["plan", "banned"] },
    );
    expect(columns).toContain("public.profiles.banned");
    expect(columns).toContain("public.profiles.plan");
    expect(columns).toStrictEqual(columns.toSorted());
    expect(
      columns.filter((item) => item.startsWith("public.memberships.")).length,
    ).toBe(source.sql.columns.length);
  });

  it("ignores attrs without a table", () => {
    expect(
      decidingColumns({ policy: "p.ts" }, { columns: ["plan"] }),
    ).toStrictEqual([]);
  });
});
