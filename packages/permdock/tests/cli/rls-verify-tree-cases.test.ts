import { describe, expect, it } from "vitest";
import { z } from "zod";

import { verifyTree } from "../../src/cli/rls-verify-tree.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  relation,
  resource,
} from "../../src/index.ts";
import { insertedRows } from "../fakes/sql.ts";

type Row = Readonly<Record<string, unknown>>;

const Node = z.object({
  id: z.number(),
  parentId: z.number().nullable(),
  ownerId: z.string().nullable(),
});
const Leaf = z.object({ id: z.number(), nodeId: z.number() });
const Person = z.object({ id: z.string(), managerId: z.string().nullable() });

const permissions = definePermissions({
  node: resource(Node, {
    actions: ["read"],
    parent: { field: "parentId", resource: "node" },
    relations: {
      owner: { field: "ownerId" },
      share: { edge: "node_shares" },
    },
  }),
  leaf: resource(Leaf, {
    actions: ["read"],
    parent: { field: "nodeId", resource: "node" },
  }),
  person: resource(Person, {
    actions: ["read"],
    parent: { field: "managerId", resource: "person" },
    relations: { manager: { principal: "managerId" } },
  }),
});

const policy = definePolicy(permissions, {
  grants: [
    allow(permissions.node.read, {
      to: relation(permissions.node, "owner", { through: "parent", depth: 2 }),
    }),
    allow(permissions.node.read, {
      to: relation(permissions.node, "share", { through: "parent", depth: 2 }),
    }),
    allow(permissions.leaf.read, {
      to: relation(permissions.node, "owner", { through: "parent", depth: 2 }),
    }),
    allow(permissions.person.read, {
      to: relation(permissions.person, "manager", {
        through: "parent",
        depth: 2,
      }),
    }),
  ],
  subject: () => null,
});

function database(required: readonly Row[] = []) {
  const inserts: { table: string; rows: Row[] }[] = [];
  const statements: string[] = [];
  const query = async (sql: string, values: readonly unknown[] = []) => {
    statements.push(sql);
    if (sql.includes("from pg_attribute")) {
      return { rows: required };
    }
    if (sql.startsWith('select "id" as value from')) {
      return { rows: [] };
    }
    if (sql.startsWith("insert into ")) {
      const rows = insertedRows({ sql, values });
      inserts.push({ table: sql.split(" ")[2] ?? "", rows });
      return { rows };
    }
    return { rows: [] };
  };
  return { query, inserts, statements };
}

describe("verifyTree over other tree shapes", () => {
  it("seeds numeric ids, owner columns, default edge columns and reporting lines", async () => {
    const db = database([
      {
        name: "tenant_id",
        type: "uuid",
        refTable: "app.orgs",
        refColumn: "id",
      },
      { name: "label", type: "text", refTable: null, refColumn: null },
      { name: 3, type: "text" },
    ]);
    const bound: string[] = [];
    const result = await verifyTree({
      policy,
      config: { rls: { tables: { node: "app.nodes" } } },
      query: db.query,
      bind: async (subject) => {
        bound.push(subject);
      },
    });
    const byTable = new Map(
      db.inserts.map((insert) => [insert.table, insert.rows]),
    );
    const nodes = byTable.get('"app"."nodes"') ?? [];
    expect(nodes.every((row) => typeof row["id"] === "number")).toBe(true);
    expect(nodes.some((row) => typeof row["ownerId"] === "string")).toBe(true);
    expect(
      nodes.every(
        (row) => row["tenant_id"] === null && row["label"] === "permdock-tree",
      ),
    ).toBe(true);
    expect(
      db.statements.some(
        (sql) => sql === 'select "id" as value from app.orgs limit 1',
      ),
    ).toBe(true);
    const shares = byTable.get('"public"."node_shares"') ?? [];
    expect(shares.length).toBeGreaterThan(0);
    expect(Object.keys(shares[0] ?? {}).toSorted()).toEqual([
      "label",
      "node_id",
      "tenant_id",
      "user_id",
    ]);
    const leaves = byTable.get('"public"."leaf"') ?? [];
    expect(leaves.every((row) => !("restricted" in row))).toBe(true);
    const people = byTable.get('"public"."person"') ?? [];
    expect(people.length).toBeGreaterThan(0);
    const managers = people
      .filter((_, index) => index % 3 === 0)
      .map((row) => String(row["id"]));
    expect(managers.every((id) => bound.includes(id))).toBe(true);
    expect(result.mismatches.length).toBeGreaterThan(0);
    expect(
      result.mismatches.every((line) => line.includes("database filtered")),
    ).toBe(true);
  });
});
