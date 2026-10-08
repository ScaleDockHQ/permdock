import { describe, expect, it } from "vitest";

import type { RelatedCondition } from "../../src/conditions/ast.ts";
import type { WhereResult } from "../../src/core/permdock.ts";

import { closureDepths, graphPlan, graphSql } from "../../src/cli/rls-graph.ts";
import {
  relatedSql,
  renderGraphSql,
  restrictedRowsSql,
} from "../../src/conditions/graph-sql.ts";
import { resolveRelated } from "../../src/conditions/resolve-related.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  type RestrictedUser,
  type TreeName,
  permissions,
  policy,
  relations,
  rows,
  treePermissions,
  users,
} from "../fixtures/restricted-stops.ts";

const chainTo = (last: number): readonly string[] =>
  Array.from(
    { length: last },
    (_, index) => `c${String(index + 1).padStart(2, "0")}`,
  );

async function visible(
  who: RestrictedUser,
  tree: TreeName,
  action: "read" | "update",
): Promise<readonly string[]> {
  const permission = treePermissions[tree][action];
  const permdock = await createPermDock(policy, who, { relations });
  await permdock.loadRelations(permission, rows);
  return rows
    .filter((row) => permdock.can(permission, row))
    .map((row) => row.id)
    .toSorted();
}

const sorted = (ids: readonly string[]): readonly string[] => ids.toSorted();

const [owner, sharer, secretViewer, member, rootViewer, deepViewer] = users;

function user(value: RestrictedUser | undefined): RestrictedUser {
  if (value === undefined) {
    throw new Error("PermDock: fixture user missing");
  }
  return value;
}

describe("restricted with stops", () => {
  it("keeps the declared stops and leaves the string form open-ended", () => {
    expect(permissions.node.read.resource).toBe("node");
    const tree = definePermissions({
      drive: resource({ actions: ["read"] }),
      folder: resource({
        actions: ["read"],
        parent: { field: "parentId", resource: "folder" },
        links: { drive: { field: "driveId", resource: "drive" } },
        restricted: {
          field: "restricted",
          stops: ["parent", "drive", "parent"],
        },
      }),
    });
    expect(policy.resources.get("node")?.restrictedStops).toEqual(["parent"]);
    expect(policy.resources.get("item")?.restrictedStops).toBeUndefined();
    expect(policy.resources.get("item")?.restricted).toBe("restricted");
    expect(tree.folder.read.resource).toBe("folder");
  });

  it("rejects stops that name nothing the resource declares", () => {
    expect(() =>
      definePermissions({
        drive: resource({ actions: ["read"] }),
        node: resource({
          actions: ["read"],
          links: { drive: { field: "driveId", resource: "drive" } },
          restricted: { field: "restricted", stops: ["folder"] },
        }),
      }),
    ).toThrow(/stops names 'folder'/u);
    expect(() =>
      definePermissions({
        node: resource({
          actions: ["read"],
          restricted: { field: "restricted", stops: ["parent"] },
        }),
      }),
    ).toThrow(/stops names 'parent'/u);
    expect(() =>
      definePermissions({
        node: resource({
          actions: ["read"],
          parent: { field: "parentId", resource: "node" },
          restricted: { field: "restricted", stops: [] },
        }),
      }),
    ).toThrow(/must list/u);
  });

  it("stops only the parent walk, so the drive still reaches a restricted row and its subtree", async () => {
    const everything = sorted(
      rows.filter((row) => row.driveId === "d1").map((row) => row.id),
    );
    for (const reader of [owner, sharer, member]) {
      expect(await visible(user(reader), "node", "read")).toEqual(everything);
    }
    expect(await visible(user(owner), "node", "update")).toEqual(everything);
    expect(await visible(user(secretViewer), "node", "read")).toEqual(
      sorted(["secret", "inner", "deep"]),
    );
    expect(await visible(user(rootViewer), "node", "read")).toEqual(
      sorted(["root", "open", ...chainTo(16)]),
    );
    expect(await visible(user(deepViewer), "node", "read")).toEqual(
      sorted(["deep", "other"]),
    );
  });

  it("closes every link for the string form, below the restricted row too", async () => {
    const reachable = sorted(["root", "open", "loose", ...chainTo(32)]);
    for (const reader of [owner, sharer, member]) {
      expect(await visible(user(reader), "item", "read")).toEqual(reachable);
    }
    expect(await visible(user(owner), "item", "update")).toEqual(reachable);
    expect(await visible(user(secretViewer), "item", "read")).toEqual(
      sorted(["secret", "inner", "deep"]),
    );
    expect(await visible(user(rootViewer), "item", "read")).toEqual(
      sorted(["root", "open", ...chainTo(16)]),
    );
    expect(await visible(user(deepViewer), "item", "read")).toEqual(["deep"]);
  });

  it("closes only the drive link when stops names it, and the parent walk passes restricted rows", async () => {
    const reachable = sorted(["root", "open", "loose", ...chainTo(32)]);
    for (const reader of [owner, sharer, member]) {
      expect(await visible(user(reader), "entry", "read")).toEqual(reachable);
    }
    expect(await visible(user(owner), "entry", "update")).toEqual(reachable);
    expect(await visible(user(secretViewer), "entry", "read")).toEqual(
      sorted(["secret", "inner", "deep", "vault", "under"]),
    );
    expect(await visible(user(rootViewer), "entry", "read")).toEqual(
      sorted([
        "root",
        "open",
        "secret",
        "inner",
        "deep",
        "vault",
        "under",
        ...chainTo(16),
      ]),
    );
    expect(await visible(user(deepViewer), "entry", "read")).toEqual(
      sorted(["deep", "vault", "under"]),
    );
  });

  it("denies a row deeper than the check reaches with relation-depth", async () => {
    const permdock = await createPermDock(policy, user(owner), { relations });
    await permdock.loadRelations(permissions.item.read, rows);
    const deepest = rows.find((row) => row.id === "c33");
    expect(permdock.decide(permissions.item.read, deepest)).toMatchObject({
      outcome: "denied",
      denials: expect.arrayContaining([
        expect.objectContaining({ reason: "relation-depth" }),
      ]),
    });
  });
});

function itemUpdate(where: WhereResult): RelatedCondition {
  const condition = where.condition;
  if (condition.op !== "related") {
    throw new Error(
      `PermDock: expected a related condition, got ${condition.op}`,
    );
  }
  return condition;
}

const text = (condition: RelatedCondition, closure?: string): string =>
  renderGraphSql(
    relatedSql(condition, {
      resources: policy.resources,
      ...(closure === undefined ? {} : { closure }),
    }),
    {
      subject: "s",
      placeholder: (index) => `$${String(index)}`,
      column: (name) => `"${name}"`,
    },
  ).sql;

describe("restricted with stops in SQL", () => {
  it("plans a 32-level closure and a restricted helper only where a link is closed", () => {
    const plan = graphPlan(policy);
    expect(closureDepths(plan)).toEqual({ entry: 32, item: 32, node: 16 });
    expect(plan.get("item")?.restrictedAncestors).toEqual({
      resource: "item",
      id: "id",
      parent: "parentId",
      field: "restricted",
      depth: 32,
    });
    expect(plan.get("node")?.restrictedAncestors).toBeUndefined();
    const sql = graphSql(
      {
        dialect: "supabase",
        scopes: scopeList(policy.scopes),
        tenantClaim: "tenant_id",
        gucPrefix: "app",
        graph: { closures: closureDepths(plan) },
      },
      plan,
      undefined,
    );
    expect(sql).toContain(
      'create or replace function "permdock".permdock_restricted_item()',
    );
    expect(sql).toContain(
      'create or replace function "permdock".permdock_restricted_entry()',
    );
    expect(sql).not.toContain("permdock_restricted_node");
    expect(sql).toContain(
      "-- entry: rows reach their ancestors up to depth 32\n",
    );
    expect(sql).toContain(
      "-- item: rows reach their ancestors up to depth 32, stopping at a restricted row",
    );
  });

  it("checks the rows above through the closure, a recursive walk or a helper", async () => {
    const permdock = await createPermDock(policy, user(owner), { relations });
    const condition = itemUpdate(permdock.where(permissions.item.update));
    expect(condition.restrictedAncestors?.depth).toBe(32);
    const closed = text(condition, "permdock_closure");
    expect(closed).toContain('"parentId" is null or "parentId"::text not in (');
    expect(closed).toContain("depth <= 31");
    expect(closed).not.toContain("with recursive");
    expect(text(condition)).toContain("with recursive");
    const above = condition.restrictedAncestors;
    if (above === undefined) {
      throw new Error("PermDock: item.update checks no rows above");
    }
    const helper = renderGraphSql(
      restrictedRowsSql(above, {
        resources: policy.resources,
        restrictedRows: (name) => [{ text: `select ${name}_closed()` }],
      }),
      { subject: "s", placeholder: () => "?", column: (name) => name },
    ).sql;
    expect(helper).toBe("select item_closed()");
    expect(
      itemUpdate(permdock.where(permissions.node.update)).restrictedAncestors,
    ).toBeUndefined();
  });

  it("resolves the rows above to a notIn on the parent for Prisma", async () => {
    const permdock = await createPermDock(policy, user(owner), { relations });
    const where = permdock.where(permissions.item.update);
    const answers = [[{ id: "d1" }], [{ id: "secret" }, { id: "inner" }]];
    const resolved = await resolveRelated(where, {
      run: () => Promise.resolve(answers.shift() ?? []),
    });
    expect(resolved.condition).toEqual({
      op: "and",
      conditions: [
        { op: "in", field: "driveId", value: ["d1"] },
        {
          op: "or",
          conditions: [
            { op: "eq", field: "restricted", value: false },
            { op: "isNull", field: "restricted", value: true },
          ],
        },
        {
          op: "or",
          conditions: [
            { op: "isNull", field: "parentId", value: true },
            { op: "notIn", field: "parentId", value: ["secret", "inner"] },
          ],
        },
      ],
    });
    const open = await resolveRelated(where, {
      run: (query) =>
        Promise.resolve(
          query.sql.includes("descendant") || query.sql.includes("recursive")
            ? []
            : [{ id: "d1" }],
        ),
    });
    expect(JSON.stringify(open.condition)).not.toContain("notIn");
    const none = await resolveRelated(where, {
      run: () => Promise.resolve([]),
    });
    expect(none.condition).toEqual({ op: "or", conditions: [] });
  });
});
