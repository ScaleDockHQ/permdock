import { describe, expect, it } from "vitest";

import { verifyTree } from "../../src/cli/rls/verify-tree.ts";
import { insertedRows } from "../fakes/sql.ts";
import { policy } from "../fixtures/graph.ts";

type Row = Readonly<Record<string, unknown>>;

/**
 * Echoes inserts back as rows and answers every visibility select with
 * `visible`.
 */
function database(
  visible: "all" | "none",
  required: Readonly<Record<string, readonly Row[]>> = {},
) {
  const inserts: { table: string; rows: Row[] }[] = [];
  const selects: string[] = [];
  const query = async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes("from pg_attribute")) {
      return { rows: required[String(values[0])] ?? [] };
    }
    if (sql.startsWith('select "id" as value from public.org')) {
      return { rows: [{ value: "acme" }] };
    }
    if (sql.startsWith("insert into ")) {
      const rows = insertedRows({ sql, values });
      inserts.push({ table: sql.split(" ")[2] ?? "", rows });
      return { rows };
    }
    selects.push(sql);
    const ids = Array.isArray(values[0]) ? values[0] : [];
    return {
      rows: visible === "all" ? ids.map((id: unknown) => ({ id })) : [],
    };
  };
  return { query, inserts, selects };
}

describe(verifyTree, () => {
  it("seeds every walked tree, its child rows and its edges in one pass", async () => {
    const db = database("none");
    const bound: string[] = [];
    const result = await verifyTree({
      policy,
      config: { rls: { tables: { doc: "documents" } } },
      query: db.query,
      bind: async (subject) => {
        bound.push(subject);
      },
    });
    const tables = db.inserts.map((insert) => insert.table);
    expect(tables).toContain('"public"."folder"');
    expect(tables).toContain('"public"."documents"');
    expect(tables).toContain('"public"."folder_members"');
    const folders = db.inserts.find(
      (insert) => insert.table === '"public"."folder"',
    );
    expect(folders?.rows.some((row) => row["restricted"] === true)).toBe(true);
    expect(
      folders?.rows.filter((row) => row["parentId"] === null),
    ).toHaveLength(2);
    expect(bound.length).toBeGreaterThanOrEqual(3);
    expect(result.checked).toBeGreaterThan(0);
    expect(db.selects.some((sql) => sql.endsWith('"id" = any($1)'))).toBe(true);
  });

  it("draws ids and timestamps from the entropy it is given", async () => {
    const db = database("none", {
      '"public"."folder"': [
        {
          name: "createdAt",
          type: "timestamp with time zone",
          refTable: null,
          refColumn: null,
        },
      ],
    });
    let next = 0;
    const bound = new Set<string>();
    await verifyTree({
      policy,
      config: {},
      query: db.query,
      bind: async (subject) => {
        bound.add(subject);
      },
      entropy: {
        now: () => Date.UTC(2026, 0, 1),
        randomUUID: () => {
          next += 1;
          return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
        },
      },
    });
    expect([...bound].toSorted()).toStrictEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ]);
    const folders = db.inserts.find(
      (insert) => insert.table === '"public"."folder"',
    );
    expect(folders?.rows[0]?.["createdAt"]).toBe("2026-01-01T00:00:00.000Z");
  });

  it("counts agreement on visible rows and reports every row the database shows but decide denies", async () => {
    const db = database("all");
    const result = await verifyTree({
      policy,
      config: {},
      query: db.query,
      bind: async () => undefined,
    });
    expect(result.granted).toBeGreaterThan(0);
    expect(result.mismatches.length).toBeGreaterThan(0);
    expect(result.mismatches[0]?.message).toMatch(
      /: in-process denied, database allowed$/u,
    );
    expect(result.mismatches[0]?.code).toBe("tree-mismatch");
    expect(result.granted + result.mismatches.length).toBe(result.checked);
  });

  it("reports every row decide grants but the database filters", async () => {
    const db = database("none");
    const result = await verifyTree({
      policy,
      config: {},
      query: db.query,
      bind: async () => undefined,
    });
    expect(result.granted).toBe(0);
    expect(
      result.mismatches.every(({ message }) =>
        message.endsWith("in-process granted, database filtered"),
      ),
    ).toBe(true);
  });

  it("fills the required columns a generated row leaves out", async () => {
    const column = (
      name: string,
      type: string,
      ref?: { readonly table: string; readonly column: string },
    ): Row => ({
      name,
      type,
      refTable: ref?.table ?? null,
      refColumn: ref?.column ?? null,
    });
    const db = database("none", {
      '"public"."folder"': [
        column("orgId", "text", { table: "public.org", column: "id" }),
        column("name", "text"),
        column("key", "uuid"),
        column("archived", "boolean"),
        column("position", "integer"),
        column("createdAt", "timestamp with time zone"),
        column("meta", "jsonb"),
        column("id", "text"),
        { name: 7, type: "text" },
      ],
    });
    await verifyTree({
      policy,
      config: {},
      query: db.query,
      bind: async () => undefined,
    });
    const row = db.inserts.find(
      (insert) => insert.table === '"public"."folder"',
    )?.rows[0];
    expect(row).toMatchObject({
      orgId: "acme",
      name: "permdock-tree",
      key: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      archived: false,
      position: 0,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      meta: {},
    });
    expect(row?.["id"]).not.toBe("permdock-tree");
  });
});
