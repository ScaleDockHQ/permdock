import { describe, expect, it } from "vitest";

import { tableMembershipSource } from "../../src/supabase/index.ts";
import { roleColumn } from "../../src/supabase/roles.ts";

const role = { column: "kind", map: { admin: "owner", user: null } };

describe("a mapped role column", () => {
  it("reads a listed value as its role and any other value as no role", () => {
    const column = roleColumn(role, "public.members", "m", { label: "role" });
    expect(column.sql).toBe(
      `case m."kind"::text when 'admin' then 'owner' when 'user' then null else null end`,
    );
    expect(column.nullable).toBe(true);
    expect(column.join).toBe("");
  });

  it("leaves the null roles out of the aggregate", () => {
    const source = tableMembershipSource({
      table: "members",
      columns: { role },
    });
    expect(source.sql.select("$1")).toContain(
      "filter (where case m.\"kind\"::text when 'admin'",
    );
  });

  it("escapes a quote in a value", () => {
    const column = roleColumn(
      { column: "kind", map: { "o'brien": "owner" } },
      "public.members",
      "m",
      { label: "role" },
    );
    expect(column.sql).toContain("when 'o''brien' then 'owner'");
  });
});
