import { describe, expect, it } from "vitest";

import type { RelationSource } from "../../src/core/interfaces.ts";

import { allow, deny } from "../../src/core/grant-builders.ts";
import {
  actor,
  anyone,
  assurance,
  authenticated,
  plan,
  relation,
} from "../../src/core/grantee.ts";
import { memoryRelationSource } from "../../src/core/memory-relations.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { whoCan } from "../../src/index.ts";
import {
  permissions as graph,
  policy as graphPolicy,
  relations,
  rows,
} from "../fixtures/graph.ts";

const deepDoc = rows.doc.find((row) => row.id === "deep-doc");
const rootDoc = rows.doc.find((row) => row.id === "root-doc");

function asynchronous(source: RelationSource): RelationSource {
  return {
    ancestors: async (query) => source.ancestors(query),
    related: async (query) => source.related(query),
  };
}

const ids = (result: {
  readonly holders: readonly { readonly principal: { readonly id: string } }[];
}) => result.holders.map((holder) => holder.principal.id);

describe("whoCan over the relationship graph", () => {
  it("loads an asynchronous source before listing, and lists only holders a decision grants", async () => {
    const permdock = getPermDockSync(
      graphPolicy,
      { id: "nobody" },
      { relations: asynchronous(relations) },
    );
    const result = await whoCan(permdock, graph.doc.read, deepDoc);
    expect(ids(result)).toStrictEqual(["carl", "eddie", "tina", "vera"]);
    expect(result.complete).toBe(false);
    const carl = result.holders.find(
      (holder) => holder.principal.id === "carl",
    );
    expect(carl?.via).toStrictEqual([
      {
        kind: "share",
        resource: "folder",
        relation: "viewer",
        id: "platform",
        group: { resource: "team", id: "eng-team", relation: "member" },
      },
    ]);
  });

  it("is incomplete and lists nobody when the source fails", async () => {
    const failing: RelationSource = {
      ancestors: () => {
        throw new Error("down");
      },
      related: () => {
        throw new Error("down");
      },
    };
    const permdock = getPermDockSync(
      graphPolicy,
      { id: "nobody" },
      { relations: failing },
    );
    const result = await whoCan(permdock, graph.doc.read, rootDoc);
    expect(result).toStrictEqual({
      permission: "doc.read",
      holders: [],
      complete: false,
    });
  });

  it("is incomplete when a group read fails after the walk", async () => {
    const source: RelationSource = {
      ancestors: (query) => relations.ancestors(query),
      related: (query) => {
        if (query.resource === "team") {
          throw new Error("teams down");
        }
        return relations.related(query);
      },
    };
    const permdock = getPermDockSync(
      graphPolicy,
      { id: "nobody" },
      { relations: source },
    );
    const result = await whoCan(permdock, graph.doc.read, deepDoc);
    expect(ids(result)).toStrictEqual(["eddie", "vera"]);
    expect(result.complete).toBe(false);
  });

  it("stops at a group cycle and at the nested-group depth", async () => {
    const chain = Array.from({ length: 20 }, (_, index) => ({
      team_id: `t${index}`,
      kind: "team",
      subject_id: `t${index + 1}`,
    }));
    const source = memoryRelationSource(graph, {
      rows,
      tables: {
        team_members: [
          { team_id: "a", kind: "team", subject_id: "b" },
          { team_id: "b", kind: "team", subject_id: "a" },
          { team_id: "b", kind: "user", subject_id: "bea" },
          ...chain,
          { team_id: "t20", kind: "user", subject_id: "far" },
          { team_id: "t1", kind: "user", subject_id: "near" },
        ],
        folder_members: [
          { folder_id: "root", role: "viewer", kind: "team", subject_id: "a" },
          { folder_id: "root", role: "viewer", kind: "team", subject_id: "t0" },
        ],
      },
    });
    const permdock = getPermDockSync(
      graphPolicy,
      { id: "nobody" },
      { relations: source },
    );
    const result = await whoCan(permdock, graph.doc.read, rootDoc);
    expect(ids(result)).toStrictEqual(["bea", "near"]);
  });

  it("names a principal relation reached through links, and nested groups of the same resource", async () => {
    const teams = definePolicy(graph, {
      grants: [
        allow(graph.doc.review, {
          to: relation(graph.team, "lead", { through: ["folder", "team"] }),
        }),
        allow(graph.team.read, { to: relation(graph.team, "member") }),
      ],
      subject: (user: { readonly id: string }) => ({ id: user.id }),
    });
    const permdock = getPermDockSync(teams, { id: "nobody" }, { relations });
    const review = await whoCan(
      permdock,
      graph.doc.review,
      rows.doc.find((row) => row.id === "eng-doc"),
    );
    expect(review.holders).toStrictEqual([
      {
        principal: { id: "lee" },
        via: [
          {
            kind: "relation",
            resource: "team",
            relation: "lead",
            id: "eng-team",
          },
        ],
      },
    ]);
    const members = await whoCan(permdock, graph.team.read, rows.team[0]);
    expect(ids(members)).toStrictEqual(["carl", "tina"]);
    expect(members.complete).toBe(true);
    const orphan = await whoCan(permdock, graph.doc.review, {
      id: "loose",
      folderId: null,
    });
    expect(orphan.holders).toStrictEqual([]);
  });

  it("lists no holder a graph deny removes", async () => {
    const denied = definePolicy(graph, {
      grants: [
        allow(graph.doc.read, {
          to: relation(graph.folder, "viewer", { through: "parent", depth: 8 }),
        }),
        deny(graph.doc.read, {
          to: relation(graph.folder, "editor", { through: "parent", depth: 8 }),
        }),
      ],
      subject: (user: { readonly id: string }) => ({ id: user.id }),
    });
    const permdock = getPermDockSync(denied, { id: "nobody" }, { relations });
    const result = await whoCan(permdock, graph.doc.read, deepDoc);
    expect(ids(result)).toStrictEqual(["carl", "tina", "vera"]);
  });

  it("lists nothing for a collection permission or a missing row", async () => {
    const permdock = getPermDockSync(graphPolicy, { id: "nobody" });
    const collection = definePermissions({
      doc: resource({ collection: ["create"] }),
    });
    // SAFETY: a collection permission, which whoCan's types refuse, from an untyped caller.
    const create = collection.doc.create as never;
    expect(await whoCan(permdock, create, {})).toStrictEqual({
      permission: "doc.create",
      holders: [],
      complete: false,
    });
    expect(await whoCan(permdock, graph.doc.read, null)).toStrictEqual({
      permission: "doc.read",
      holders: [],
      complete: false,
    });
  });
});

const tree = definePermissions({
  task: resource({
    actions: ["read", "update", "close"],
    relations: {
      assignee: { field: "assigneeId" },
      reporter: { principal: "reporterId" },
      org: { field: "orgId", memberOf: "org" },
      involved: { includes: ["assignee", "reporter"] },
    },
  }),
});

const task = {
  id: "t1",
  orgId: "acme",
  assigneeId: "ann",
  reporterId: "rex",
  teamId: "blue",
};

const members = {
  membershipsFor: () => [],
  list: ({ scope, id }: { readonly scope: string; readonly id: string }) =>
    scope === "org" && id === "acme"
      ? [
          {
            principal: { id: "olive" },
            membership: { scope: "org", id: "acme", roles: ["lead"] },
          },
          {
            principal: { id: "oscar" },
            membership: { scope: "org", id: "acme", roles: ["guest"] },
          },
          {
            // SAFETY: a source returning an entry without a principal id; whoCan skips it.
            principal: {} as { readonly id: string },
            membership: { scope: "org", id: "acme", roles: ["lead"] },
          },
        ]
      : [],
};

describe("whoCan over field, principal and scope relations", () => {
  const scoped = definePolicy(tree, {
    scopes: { org: { key: "orgId" } },
    roles: [
      role("lead", [allow(tree.task.close)], { on: "org" }),
      role("guest", [deny(tree.task.close)], { on: "org" }),
    ],
    grants: [
      allow(tree.task.read, { to: relation(tree.task, "involved") }),
      allow(tree.task.read, { to: relation(tree.task, "org") }),
      allow(tree.task.update, { to: relation(tree.task, "assignee") }),
      deny(tree.task.update, { to: relation(tree.task, "reporter") }),
    ],
    subject: (user: { readonly id: string }) => ({ id: user.id }),
  });

  it("expands included relations and lists the scope members of a memberOf relation", async () => {
    const permdock = getPermDockSync(
      scoped,
      { id: "viewer" },
      { memberships: members },
    );
    const read = await whoCan(permdock, tree.task.read, task);
    expect(ids(read)).toStrictEqual(["ann", "olive", "oscar", "rex"]);
    expect(read.complete).toBe(true);
    expect(read.holders[0]?.via).toStrictEqual([
      { kind: "relation", resource: "task", relation: "assignee", id: "t1" },
    ]);
  });

  it("drops a holder a deny grant removes and records no via for the deny", async () => {
    const permdock = getPermDockSync(
      scoped,
      { id: "viewer" },
      { memberships: members },
    );
    const update = await whoCan(permdock, tree.task.update, {
      ...task,
      reporterId: "ann",
    });
    expect(update.holders).toStrictEqual([]);
    const close = await whoCan(permdock, tree.task.close, task);
    expect(ids(close)).toStrictEqual(["olive"]);
    expect(close.holders[0]?.via[0]).toMatchObject({
      kind: "role",
      role: "lead",
    });
  });

  it("is incomplete without a member list, and lists nobody for a row outside every scope", async () => {
    const unlisted = getPermDockSync(
      scoped,
      { id: "viewer" },
      { memberships: { membershipsFor: () => [] } },
    );
    const read = await whoCan(unlisted, tree.task.read, task);
    expect(ids(read)).toStrictEqual(["ann", "rex"]);
    expect(read.complete).toBe(false);
    const throwing = getPermDockSync(
      scoped,
      { id: "viewer" },
      {
        memberships: {
          membershipsFor: () => [],
          list: () => {
            throw new Error("directory down");
          },
        },
      },
    );
    expect((await whoCan(throwing, tree.task.close, task)).complete).toBe(
      false,
    );
    const permdock = getPermDockSync(
      scoped,
      { id: "viewer" },
      { memberships: members },
    );
    const orphan = await whoCan(permdock, tree.task.close, { id: "t2" });
    expect(orphan).toStrictEqual({
      permission: "task.close",
      holders: [],
      complete: true,
    });
    const noField = await whoCan(permdock, tree.task.read, { id: "t3" });
    expect(noField.holders).toStrictEqual([]);
  });

  it("is incomplete for grantees it cannot enumerate", async () => {
    for (const to of [
      anyone(),
      authenticated(),
      plan("pro"),
      actor("agent"),
      assurance({ acr: "mfa" }),
      "admin",
      // SAFETY: a grantee kind this build does not know, as a forged policy could carry.
      { kind: "wizard", matched: true } as never,
    ]) {
      const open = definePolicy(tree, {
        grants: [allow(tree.task.read, { to })],
        subject: (user: { readonly id: string }) => ({ id: user.id }),
      });
      const permdock = getPermDockSync(open, { id: "viewer" });
      const result = await whoCan(permdock, tree.task.read, task);
      expect({ to, result }).toStrictEqual({
        to,
        result: { permission: "task.read", holders: [], complete: false },
      });
    }
  });
});
