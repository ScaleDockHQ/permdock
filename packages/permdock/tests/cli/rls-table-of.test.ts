import { describe, expect, it } from "vitest";

import {
  checkSharedTables,
  tableNameOf,
  tableNames,
  tablelessResources,
} from "../../src/cli/sql/tables.ts";

describe("rls.tables tableOf", () => {
  const tables = {
    file: "public.file_nodes",
    fileNode: { tableOf: "file" },
    note: { tableOf: "unlisted" },
  } as const;

  it("resolves to the owner's table", () => {
    expect(tableNameOf(tables.fileNode, "fileNode", tables)).toBe(
      "public.file_nodes",
    );
    expect(tableNames(tables)).toStrictEqual({
      file: "public.file_nodes",
      fileNode: "public.file_nodes",
      note: "unlisted",
    });
  });

  it("gives the sharing resource no policies, like a table that is false", () => {
    expect(tablelessResources({ ...tables, console: false })).toStrictEqual(
      new Set(["fileNode", "note", "console"]),
    );
  });

  it("rejects an owner that is the resource itself, false or another tableOf", () => {
    expect(() => checkSharedTables(tables)).not.toThrow();
    for (const bad of [
      { a: { tableOf: "a" } },
      { a: { tableOf: "b" }, b: false },
      { a: { tableOf: "b" }, b: { tableOf: "c" } },
    ] as const) {
      expect(() => checkSharedTables(bad)).toThrow(
        /tableOf names .*another resource with a table of its own/u,
      );
    }
  });

  it("names the owner's resource when the owner's own entry is not a table", () => {
    expect(tableNameOf({ tableOf: "file" }, "fileNode", { file: false })).toBe(
      "file",
    );
    expect(tableNameOf({ tableOf: "file" }, "fileNode")).toBe("file");
    expect(
      tableNameOf({ tableOf: "file" }, "fileNode", { file: "public.files" }),
    ).toBe("public.files");
    expect(tableNameOf({ tableOf: "b" }, "a", { b: { tableOf: "c" } })).toBe(
      "b",
    );
    expect(tableNames(undefined)).toBeUndefined();
    expect(() => checkSharedTables(undefined)).not.toThrow();
    expect(() => checkSharedTables({ a: "public.a", b: false })).not.toThrow();
  });
});
