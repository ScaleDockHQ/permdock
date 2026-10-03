import { describe, expect, it } from "vitest";

import { conditionFields, indexName } from "../../src/cli/rls-indexes.ts";

describe("conditionFields", () => {
  it("walks and, or, not and sqlFunction twins, and skips JSON paths and related", () => {
    expect(
      conditionFields({
        op: "and",
        conditions: [
          { op: "eq", field: "status", value: "open" },
          {
            op: "or",
            conditions: [
              {
                op: "not",
                condition: { op: "isNull", field: "owner_id", value: true },
              },
              { op: "in", field: "meta.kind", value: ["a"] },
              {
                op: "related",
                resource: "folder",
                relation: "viewer",
                field: "folder_id",
                depth: 0,
              },
            ],
          },
          {
            op: "sqlFunction",
            name: "f",
            args: [],
            twin: { op: "gt", field: "amount", value: 1 },
          },
        ],
      }),
    ).toEqual(["status", "owner_id", "amount"]);
    expect(conditionFields(undefined)).toEqual([]);
  });
});

describe("indexName", () => {
  it("names the table and columns, and hashes a name over 63 bytes", () => {
    expect(indexName({ table: "public.invoice", columns: ["status"] })).toBe(
      "permdock_invoice_status_idx",
    );
    const long = indexName({
      table: "public.a_table_with_a_rather_long_name",
      columns: ["and_a_long_column_name_as_well"],
    });
    expect(long).toMatch(/^permdock_[0-9a-f]{8}_idx$/u);
  });
});
