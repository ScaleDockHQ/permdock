import { describe, expect, it } from "vitest";

import type { RlsTable } from "../../src/cli/types.ts";
import type { Scope } from "../../src/core/scopes.ts";

import {
  resolveVias,
  tableNameOf,
  tableNames,
} from "../../src/cli/sql/tables.ts";

// SAFETY: resolveVias reads only `name` from a scope
const scopes = [{ name: "org" }, { name: "team" }] as unknown as Scope[];

const via = (table: string, extra: object = {}): RlsTable => ({
  via: { table, column: "org_id", ...extra },
});

describe("tableNameOf", () => {
  it("falls back to the resource, a string, or the object's table", () => {
    expect(tableNameOf(undefined, "post")).toBe("post");
    expect(tableNameOf("app.posts", "post")).toBe("app.posts");
    expect(
      tableNameOf(
        { table: "app.t", via: { table: "p", column: "org_id" } },
        "post",
      ),
    ).toBe("app.t");
    expect(tableNameOf(via("projects"), "post")).toBe("post");
  });
});

describe("tableNames", () => {
  it("reduces every entry to a table name and keeps undefined", () => {
    expect(tableNames(undefined)).toBeUndefined();
    expect(tableNames({ post: "posts", task: via("projects") })).toEqual({
      post: "posts",
      task: "task",
    });
  });
});

describe("resolveVias", () => {
  it("answers undefined without a via entry", () => {
    expect(resolveVias(undefined, scopes, "supabase")).toBeUndefined();
    expect(resolveVias({ post: "posts" }, scopes, "supabase")).toBeUndefined();
  });

  it("fills defaults and singularises the parent table", () => {
    const out = resolveVias(
      {
        task: via("projects"),
        note: via("app.widgets", {
          scope: "team",
          key: "bx",
          id: "pk",
          type: "int",
        }),
        a: via("addresses"),
        c: via("categories"),
        b: via("glass"),
      },
      scopes,
      "supabase",
    );
    expect(out?.["task"]).toMatchObject({
      helper: "permitted_project_ids",
      key: "project_id",
      scope: "org",
      table: "public.projects",
      id: "id",
      type: "uuid",
    });
    expect(out?.["note"]).toMatchObject({
      helper: "permitted_widget_ids",
      key: "bx",
      scope: "team",
      table: "app.widgets",
      id: "pk",
      type: "int",
    });
    expect(out?.["a"]?.helper).toBe("permitted_address_ids");
    expect(out?.["b"]?.helper).toBe("permitted_glass_ids");
    expect(out?.["c"]?.helper).toBe("permitted_category_ids");
  });

  it("uses text ids outside the supabase dialect and shares an identical helper", () => {
    const out = resolveVias(
      { a: via("projects"), b: via("projects") },
      scopes,
      "postgres",
    );
    expect(out?.["a"]?.type).toBe("text");
    expect(out?.["b"]?.helper).toBe(out?.["a"]?.helper);
  });

  it("refuses an unknown scope and a policy without scopes", () => {
    expect(() =>
      resolveVias(
        { a: via("projects", { scope: "nope" }) },
        scopes,
        "supabase",
      ),
    ).toThrow(/is not a scope/u);
    expect(() => resolveVias({ a: via("projects") }, [], "supabase")).toThrow(
      /is not a scope/u,
    );
  });

  it("refuses one helper over two different parents", () => {
    expect(() =>
      resolveVias(
        { a: via("projects"), b: via("app.projects") },
        scopes,
        "supabase",
      ),
    ).toThrow(/another resource defines/u);
  });
});
