import { describe, expect, it } from "vitest";

import { compileConditionSql } from "../../src/cli/rls-conditions.ts";
import { scopeList } from "../../src/core/scopes.ts";

const ctx = {
  dialect: "supabase",
  scopes: scopeList(undefined),
  tenantClaim: "tenant_id",
  gucPrefix: "app",
} as const;

describe("contains in generated SQL", () => {
  it("matches %, _ and backslash literally, like the in-process where", () => {
    const sql = compileConditionSql(
      { op: "contains", field: "title", value: "50%_off\\" },
      ctx,
    );
    expect(sql).toBe(
      `"title"::text like '%' || replace(replace(replace('50%_off\\'::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' escape '\\'`,
    );
  });

  it("escapes a claim value the same way", () => {
    expect(
      compileConditionSql(
        {
          op: "contains",
          field: "title",
          value: { ref: "principal.claims.q" },
        },
        ctx,
      ),
    ).toContain(`escape '\\'`);
  });
});
