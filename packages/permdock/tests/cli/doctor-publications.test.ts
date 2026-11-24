import { describe, expect, it } from "vitest";

import { pd124 } from "../../src/cli/doctor/publications.ts";

function database(rows: readonly Record<string, unknown>[]) {
  const asked: unknown[][] = [];
  return {
    asked,
    database: {
      url: "postgres://x",
      connect: () =>
        Promise.resolve({
          query: (_sql: string, params: readonly unknown[]) => {
            asked.push([...params]);
            return Promise.resolve({ rows });
          },
          end: () => Promise.resolve(),
        }),
    },
  };
}

describe(pd124, () => {
  it("lists published tables with PermDock policies outside Realtime and PowerSync", async () => {
    const { asked, database: db } = database([
      { pubname: "etl", schemaname: "public", tablename: "invoices" },
      { pubname: "supabase_realtime", schemaname: "public", tablename: "chat" },
      {
        pubname: "supabase_realtime_messages_publication",
        schemaname: "realtime",
        tablename: "messages",
      },
      { pubname: "powersync", schemaname: "public", tablename: "todos" },
    ]);
    const findings = await pd124({
      config: { rls: { tables: {}, schema: "authz" } },
      database: db,
    });
    expect(findings).toStrictEqual([
      expect.objectContaining({
        code: "PD124",
        severity: "info",
        target: "etl:public.invoices",
      }),
    ]);
    expect(asked).toStrictEqual([["authz."]]);
  });

  it("needs a database URL and rls", async () => {
    const { database: db } = database([
      { pubname: "etl", schemaname: "public", tablename: "invoices" },
    ]);
    expect(await pd124({ config: { rls: { tables: {} } } })).toStrictEqual([]);
    expect(await pd124({ config: {}, database: db })).toStrictEqual([]);
  });
});
