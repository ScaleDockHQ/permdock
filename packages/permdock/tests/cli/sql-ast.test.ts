import { describe, expect, it } from "vitest";

import {
  SqlSyntaxError,
  charIndex,
  parseSqlFile,
  removeStatements,
  replaceStatement,
} from "../../src/cli/sql/ast.ts";

describe(parseSqlFile, () => {
  it("returns typed nodes with string ranges and lines", async () => {
    const sql =
      "-- header ; é 😀\ncreate table t (a text default 'a--b');\n\ncreate policy p on public.orders for select using (x = ';');\n";
    const nodes = await parseSqlFile(sql);
    expect(nodes.map((node) => node.kind)).toStrictEqual([
      "CreateStmt",
      "CreatePolicyStmt",
    ]);
    expect(nodes.map((node) => node.line)).toStrictEqual([2, 4]);
    expect(nodes[0]?.text).toBe("create table t (a text default 'a--b')");
    expect(nodes[1]?.text).toBe(
      "create policy p on public.orders for select using (x = ';')",
    );
    for (const node of nodes) {
      expect(sql.slice(node.start, node.end)).toBe(node.text);
    }
  });

  it("reads the table of a policy as schema and name", async () => {
    const [policy] = await parseSqlFile(
      'create policy p on public."my.orders" for select using (true);',
    );
    expect(policy?.node["table"]).toMatchObject({
      schemaname: "public",
      relname: "my.orders",
    });
  });

  it("does not take a `for update` in a subquery as the policy command", async () => {
    const [policy] = await parseSqlFile(
      "create policy p on t for select using (exists (select 1 from u for update));",
    );
    expect(policy?.node["cmd_name"]).toBe("select");
  });

  it("names the line and column of a syntax error", async () => {
    await expect(
      parseSqlFile("select 1;\ncreate table ("),
    ).rejects.toBeInstanceOf(SqlSyntaxError);
    await expect(
      parseSqlFile("select 1;\nselect from from;"),
    ).rejects.toMatchObject({ line: 2 });
    await expect(
      parseSqlFile("-- é\nselect 1;\nthis is not sql;"),
    ).rejects.toMatchObject({ line: 3, column: 1 });
  });

  it("splits a $a1$ body once and keeps `E'it\\'s;x'` in one statement", async () => {
    const nodes = await parseSqlFile(
      "create function f() returns int language sql as $a1$ select 1; $a1$;\nselect E'it\\'s;x';",
    );
    expect(nodes.map((node) => node.kind)).toStrictEqual([
      "CreateFunctionStmt",
      "SelectStmt",
    ]);
  });
});

describe(charIndex, () => {
  it("maps byte offsets after non-ASCII text onto string indices", () => {
    const text = "é😀x";
    const at = charIndex(text);
    expect(at(Buffer.byteLength("é😀"))).toBe("é😀".length);
  });
});

describe("removeStatements and replaceStatement", () => {
  it("removes a statement with its terminator and keeps the rest byte for byte", async () => {
    const sql =
      "create table a (id int);\ncreate table b (id int); -- keep\nselect 1;\n";
    const nodes = await parseSqlFile(sql);
    expect(
      removeStatements(sql, nodes, (node) => node.text.includes("table a")),
    ).toBe("create table b (id int); -- keep\nselect 1;\n");
  });

  it("replaces one statement's source", async () => {
    const sql = "select 1;\nselect 2;\n";
    const nodes = await parseSqlFile(sql);
    const second = nodes[1];
    expect(second).toBeDefined();
    expect(second && replaceStatement(sql, second, "select 3")).toBe(
      "select 1;\nselect 3;\n",
    );
  });
});
