import { describe, expect, it } from "vitest";

import {
  decidingColumns,
  membershipColumns,
  tableKey,
} from "../../src/cli/deciding-columns.ts";
import { fromTable } from "../../src/supabase/index.ts";

describe("tableKey", () => {
  it("qualifies, unquotes and lower-cases a table name", () => {
    expect(tableKey("Members")).toBe("public.members");
    expect(tableKey('"Auth"."Members"')).toBe("auth.members");
  });
});

describe("membershipColumns", () => {
  it("prefers the hook sources over rls.membershipSources", () => {
    const hook = fromTable({ table: "memberships" });
    const rls = fromTable({ table: "other_members" });
    const config = {
      policy: "p.ts",
      supabase: { hook: { memberships: [hook] } },
      rls: { membershipSources: [rls] },
    };
    expect([...membershipColumns(config).keys()]).toEqual([
      "public.memberships",
    ]);
  });

  it("falls back to rls.membershipSources, then to nothing", () => {
    const rls = fromTable({ table: "app.members" });
    expect([
      ...membershipColumns({
        policy: "p.ts",
        rls: { membershipSources: [rls] },
      }).keys(),
    ]).toEqual(["app.members"]);
    expect(membershipColumns({ policy: "p.ts" }).size).toBe(0);
  });

  it("merges the columns of two sources on one table", () => {
    const a = fromTable({ table: "memberships" });
    const b = fromTable({ table: "public.memberships" });
    const columns = membershipColumns({
      policy: "p.ts",
      rls: { membershipSources: [a, b] },
    });
    expect(columns.size).toBe(1);
    expect([...(columns.get("public.memberships") ?? [])]).toEqual([
      ...new Set([...a.sql.columns, ...b.sql.columns]),
    ]);
  });
});

describe("decidingColumns", () => {
  it("lists membership and attrs columns, sorted", () => {
    const source = fromTable({ table: "memberships" });
    const columns = decidingColumns(
      { policy: "p.ts", rls: { membershipSources: [source] } },
      { table: "profiles", columns: ["plan", "banned"] },
    );
    expect(columns).toContain("public.profiles.banned");
    expect(columns).toContain("public.profiles.plan");
    expect(columns).toEqual(columns.toSorted());
    expect(
      columns.filter((item) => item.startsWith("public.memberships.")).length,
    ).toBe(source.sql.columns.length);
  });

  it("ignores attrs without a table", () => {
    expect(decidingColumns({ policy: "p.ts" }, { columns: ["plan"] })).toEqual(
      [],
    );
  });
});
