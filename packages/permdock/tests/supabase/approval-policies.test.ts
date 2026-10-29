import { describe, expect, it } from "vitest";

import { tableApprovalPolicySource } from "../../src/supabase/index.ts";

describe(tableApprovalPolicySource, () => {
  it("reads the bodies for the subject's tenants from the schema's function", async () => {
    const calls: { sql: string; params: readonly unknown[] | undefined }[] = [];
    const source = tableApprovalPolicySource({
      schema: "authz",
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [{ body: { name: "floor" } }] };
      },
    });
    expect(source.name).toBe("table");
    expect(
      await source.approvalPoliciesFor({ tenants: ["t1", "t2"] }),
    ).toStrictEqual([{ name: "floor" }]);
    expect(calls).toStrictEqual([
      {
        sql: 'select p.body from "authz"."permdock_approval_policies_for"($1::text[]) p(body)',
        params: [["t1", "t2"]],
      },
    ]);
  });

  it("takes bare rows from the default schema and throws on a body that is not an object", async () => {
    const sql: string[] = [];
    const source = tableApprovalPolicySource({
      query: async (text) => {
        sql.push(text);
        return [{ body: "nope" }];
      },
    });
    await expect(source.approvalPoliciesFor({ tenants: [] })).rejects.toThrow(
      "body that is not an object",
    );
    expect(sql[0]).toContain('"permdock"."permdock_approval_policies_for"');
  });
});
