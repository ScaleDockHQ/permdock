import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { GraphPlan, GraphResource } from "../../src/cli/rls-graph.ts";
import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { closureDepths, graphPlan, graphSql } from "../../src/cli/rls-graph.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  relation,
  resource,
} from "../../src/index.ts";
import { policy as graphFixture } from "../fixtures/graph.ts";

const Node = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  ownerId: z.string().nullable(),
  orgId: z.string(),
});

const permissions = definePermissions({
  node: resource(Node, {
    actions: ["read", "update"],
    parent: { field: "parentId", resource: "node" },
    relations: {
      owner: { field: "ownerId" },
      org: { field: "orgId", memberOf: "tenant" },
    },
  }),
});

const policy = definePolicy(permissions, {
  grants: [
    allow(permissions.node.read, {
      to: relation(permissions.node, "owner", { through: "parent", depth: 3 }),
    }),
    allow(permissions.node.update, { to: relation(permissions.node, "org") }),
  ],
  subject: () => null,
});

const ctx: RlsSqlContext = {
  dialect: "supabase",
  scopes: [{ name: "tenant" }],
  tenantClaim: "tenant_id",
  gucPrefix: "app",
  schema: "authz",
};

function withEntry(
  plan: GraphPlan,
  name: string,
  over: Partial<GraphResource>,
): GraphPlan {
  const entry = plan.get(name);
  if (entry === undefined) {
    throw new Error(`no plan entry ${name}`);
  }
  return new Map([...plan, [name, { ...entry, ...over }]]);
}

describe("graphPlan", () => {
  it("skips a relation grantee that compiles to a membership", () => {
    const plan = graphPlan(policy);
    expect([...(plan.get("node")?.relations ?? [])]).toEqual(["owner"]);
    expect(closureDepths(plan)).toEqual({ node: 3 });
  });
});

describe("graphSql", () => {
  it("writes the closure without restricted stops for an unrestricted tree", () => {
    const text = graphSql(ctx, graphPlan(policy), { node: "app.nodes" });
    expect(text).toContain(
      'create or replace function "authz".permitted_node_ids(p_relation text)',
    );
    expect(text).toContain(`(p_relation is null or p_relation = 'owner')`);
    expect(text).toContain(
      'select t."id"::text, t."id", t."parentId", 0, false',
    );
    expect(text).toContain('from "app"."nodes" t');
    expect(text).not.toContain('is distinct from o."restricted"');
  });

  it("guards an arm that several asked relations reach with an in list", () => {
    const plan = withEntry(graphPlan(graphFixture), "folder", {
      relations: new Set(["editor", "viewer"]),
    });
    expect(graphSql(ctx, plan, undefined)).toContain(
      `(p_relation is null or p_relation in ('editor', 'viewer'))`,
    );
  });

  it("writes an empty helper when no asked relation expands", () => {
    const plan = withEntry(graphPlan(policy), "node", {
      relations: new Set(["ghost"]),
    });
    expect(graphSql(ctx, plan, undefined)).toContain(
      "  select null::text where false",
    );
  });

  it("writes only link helpers for a resource no relation is asked on", () => {
    const plan = withEntry(graphPlan(graphFixture), "folder", {
      relations: new Set(),
      links: new Set(["team"]),
    });
    const text = graphSql(ctx, plan, undefined);
    expect(text).not.toContain('"authz".permitted_folder_ids(p_relation text)');
    expect(text).toContain(
      'create or replace function "authz".permdock_link_folder_team(p_ids text[])',
    );
  });

  it("writes no closure objects for a walked resource without a parent", () => {
    const plan = withEntry(graphPlan(graphFixture), "team", { closure: 2 });
    const text = graphSql(ctx, plan, undefined);
    expect(text).not.toContain("-- team: rows reach their ancestors");
    expect(text).toContain("-- folder: rows reach their ancestors");
  });

  it.each([
    [
      "a membership relation",
      "node",
      { relations: new Set(["org"]) },
      "relation 'org' on node is not a graph relation RLS can compile",
    ],
    [
      "an unknown link",
      "node",
      { links: new Set(["nowhere"]) },
      "node has no link 'nowhere'",
    ],
  ] as const)("refuses %s", (_name, entry, over, message) => {
    expect(() =>
      graphSql(ctx, withEntry(graphPlan(policy), entry, over), undefined),
    ).toThrow(message);
  });

  it("refuses a graph resource named like a scope", () => {
    expect(() =>
      graphSql(
        { ...ctx, scopes: [{ name: "node" }] },
        graphPlan(policy),
        undefined,
      ),
    ).toThrow(
      "resource 'node' has graph relations and shares its SQL name with the node scope",
    );
  });
});
