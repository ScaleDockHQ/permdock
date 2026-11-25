import { describe, expect, it } from "vitest";

import type { SqlClient } from "../../src/cli/pg.ts";

import { pd138 } from "../../src/cli/doctor/truncated-users.ts";

function database(row: Record<string, unknown>) {
  const asked: string[] = [];
  return {
    asked,
    database: {
      url: "postgres://x",
      connect: (): Promise<SqlClient> =>
        Promise.resolve({
          query: (sql) => {
            asked.push(sql.trim().split(/\s/u)[0] ?? "");
            return Promise.resolve({ rows: [row] });
          },
          end: () => Promise.resolve(),
        }),
    },
  };
}

const config = { supabase: { hook: { budget: 1024 } } };

describe(pd138, () => {
  it("counts the users the budget truncates inside a rolled-back transaction", async () => {
    const { asked, database: db } = database({ users: 400, truncated: 12 });
    const findings = await pd138({ config, database: db });
    expect(findings).toStrictEqual([
      expect.objectContaining({
        code: "PD138",
        severity: "info",
        message: expect.stringContaining("memberships of 12 of 400 users"),
      }),
    ]);
    expect(asked).toStrictEqual(["begin", "select", "rollback"]);
  });

  it("reports nothing when no user is truncated, without a hook or without a database", async () => {
    const { database: db } = database({ users: 400, truncated: 0 });
    expect(await pd138({ config, database: db })).toStrictEqual([]);
    expect(await pd138({ config: {}, database: db })).toStrictEqual([]);
    expect(await pd138({ config })).toStrictEqual([]);
  });
});
