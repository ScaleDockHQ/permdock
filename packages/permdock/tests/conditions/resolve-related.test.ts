import { describe, expect, it } from "vitest";

import type { Condition, RelatedCondition } from "../../src/conditions/ast.ts";
import type { WhereResult } from "../../src/core/permdock.ts";

import { resolveRelated } from "../../src/conditions/resolve-related.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { permissions, policy, relations } from "../fixtures/graph.ts";

type Query = { readonly sql: string; readonly values: readonly unknown[] };

async function graphWhere(id: string): Promise<WhereResult> {
  const permdock = await createPermDock(policy, { id }, { relations });
  return permdock.where(permissions.doc.read);
}

function withCondition(where: WhereResult, condition: Condition): WhereResult {
  const out = { condition, partial: false };
  for (const key of ["subject", "resources"] as const) {
    Object.defineProperty(out, key, { value: where[key], enumerable: false });
  }
  // SAFETY: out copies where's non-enumerable subject and resources above, as WhereResult carries.
  return out as WhereResult;
}

const viewerOfParent: RelatedCondition = {
  op: "related",
  resource: "folder",
  relation: "viewer",
  field: "parentId",
  depth: 0,
  parent: true,
  restricted: "restricted",
};

const unrestrictedViewerOfParent: RelatedCondition = {
  op: "related",
  resource: "folder",
  relation: "viewer",
  field: "parentId",
  depth: 0,
  parent: true,
};

describe("resolveRelated", () => {
  it("replaces each related node with the ids one query reads", async () => {
    const where = await graphWhere("vera");
    const queries: Query[] = [];
    const resolved = await resolveRelated(where, {
      run: (query) => {
        queries.push(query);
        return Promise.resolve([
          { id: "root" },
          { id: "eng" },
          { id: null },
          { id: { nested: true } },
        ]);
      },
    });
    expect(queries.length).toBeGreaterThan(0);
    expect(queries[0]?.sql).toMatch(
      /^select distinct r\.id from \(.*"folder_members".*\) r where r\.id is not null$/su,
    );
    expect(queries[0]?.values).toContain("vera");
    expect(JSON.stringify(resolved.condition)).not.toContain('"related"');
    expect(JSON.stringify(resolved.condition)).toContain(
      '{"op":"in","field":"folderId","value":["root","eng"]}',
    );
    expect(resolved.subject).toBe(where.subject);
    expect(Object.keys(resolved)).toEqual(["condition", "partial"]);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it("parses ids, keeps scalar results and drops the rest", async () => {
    const where = await graphWhere("vera");
    const resolved = await resolveRelated(
      withCondition(where, viewerOfParent),
      {
        run: () => Promise.resolve([{ id: 7 }, { id: "8" }, { id: "x" }]),
        parse: (id, field) =>
          field === "parentId" && id !== "x" ? Number(id) : undefined,
      },
    );
    expect(resolved.condition).toEqual({
      op: "and",
      conditions: [
        { op: "in", field: "parentId", value: [7, 8] },
        {
          op: "or",
          conditions: [
            { op: "eq", field: "restricted", value: false },
            { op: "isNull", field: "restricted", value: true },
          ],
        },
      ],
    });
  });

  it("resolves nodes under not, and, or and sqlFunction twins, leaving the rest", async () => {
    const where = await graphWhere("vera");
    const eq: Condition = { op: "eq", field: "id", value: "a" };
    const resolved = await resolveRelated(
      withCondition(where, {
        op: "and",
        conditions: [
          eq,
          {
            op: "not",
            condition: unrestrictedViewerOfParent,
          },
          {
            op: "sqlFunction",
            name: "f",
            args: [],
            twin: { op: "or", conditions: [viewerOfParent] },
          },
        ],
      }),
      { run: () => Promise.resolve([]) },
    );
    const nothing = { op: "or", conditions: [] };
    expect(resolved.condition).toEqual({
      op: "and",
      conditions: [
        eq,
        { op: "not", condition: nothing },
        {
          op: "sqlFunction",
          name: "f",
          args: [],
          twin: { op: "or", conditions: [nothing] },
        },
      ],
    });
  });

  it("reaches nothing without a principal, and refuses a result with no graph", async () => {
    const where = await graphWhere("vera");
    let ran = false;
    const anonymous = { condition: viewerOfParent, partial: false };
    Object.defineProperty(anonymous, "resources", {
      value: where.resources,
      enumerable: false,
    });
    // SAFETY: a WhereResult with resources defined above and deliberately no subject.
    const resolved = await resolveRelated(anonymous as WhereResult, {
      run: () => {
        ran = true;
        return Promise.resolve([{ id: "root" }]);
      },
    });
    expect(ran).toBe(false);
    expect(resolved.condition).toEqual({ op: "or", conditions: [] });

    // SAFETY: deliberately a WhereResult without its resource graph, to exercise the refusal.
    await expect(
      resolveRelated(
        { condition: viewerOfParent, partial: false } as WhereResult,
        {
          run: () => Promise.resolve([]),
        },
      ),
    ).rejects.toMatchObject({ code: "non-portable-condition" });
  });

  it("reads the ids of a resource role without a principal lookup", async () => {
    const where = await graphWhere("vera");
    const queries: Query[] = [];
    await resolveRelated(
      withCondition(where, {
        ...viewerOfParent,
        relation: "",
        ids: ["eng"],
        depth: 2,
      }),
      {
        relations: { closure: "permdock_closure" },
        run: (query) => {
          queries.push(query);
          return Promise.resolve([]);
        },
      },
    );
    expect(queries[0]?.sql).toContain('"permdock_closure"');
    expect(queries[0]?.values).toEqual(["folder", "eng"]);
  });
});
