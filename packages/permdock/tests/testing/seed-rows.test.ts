import { describe, expect, it } from "vitest";

import type { RlsQueryFn } from "../../src/testing/index.ts";

import { seedRows } from "../../src/testing/index.ts";

function recorder(): {
  readonly query: RlsQueryFn;
  readonly calls: { readonly sql: string; readonly values: unknown }[];
} {
  const calls: { readonly sql: string; readonly values: unknown }[] = [];
  return {
    calls,
    query: (sql, values) => {
      calls.push({ sql, values });
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  };
}

describe(seedRows, () => {
  it("inserts each row with its own keys as quoted columns, tables in key order", async () => {
    const { query, calls } = recorder();
    const inserted = await seedRows(query, {
      "app.project": [
        { id: "p1", organizationId: "o1", budget: null, tags: ["a"] },
      ],
      task_item: [
        { id: "t1", projectId: "p1", note: undefined },
        { id: "t2", projectId: "p1" },
      ],
      empty: [{}],
    });
    expect(inserted).toBe(4);
    expect(calls).toStrictEqual([
      {
        sql: 'insert into "app"."project" ("id", "organizationId", "budget", "tags") values ($1, $2, $3, $4)',
        values: ["p1", "o1", null, ["a"]],
      },
      {
        sql: 'insert into "task_item" ("id", "projectId") values ($1, $2)',
        values: ["t1", "p1"],
      },
      {
        sql: 'insert into "task_item" ("id", "projectId") values ($1, $2)',
        values: ["t2", "p1"],
      },
      { sql: 'insert into "empty" default values', values: [] },
    ]);
  });

  it("refuses a table or column that is not a plain identifier", async () => {
    const { query, calls } = recorder();
    await expect(
      seedRows(query, { 'post"; drop table post; --': [{ id: "p1" }] }),
    ).rejects.toThrow(TypeError);
    await expect(
      seedRows(query, { post: [{ 'id" = 1; --': "p1" }] }),
    ).rejects.toThrow(TypeError);
    expect(calls).toStrictEqual([]);
  });
});
