import { describe, expect, it } from "vitest";

import type { RelationSource } from "../../src/core/interfaces.ts";

import {
  actor,
  anyone,
  assurance,
  authenticated,
  plan,
  relation,
} from "../../src/core/grantee.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, deny, role } from "../../src/core/policy.ts";
import { memoryRelations } from "../../src/core/relations.ts";
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
    const permdock = await createPermDock(
      graphPolicy,
      { id: "nobody" },
      { relations: asynchronous(relations) },
    );
    const result = await permdock.whoCan(graph.doc.read, deepDoc);
    expect(ids(result)).toEqual(["carl", "eddie", "tina", "vera"]);
    expect(result.complete).toBe(false);
    const carl = result.holders.find(
      (holder) => holder.principal.id === "carl",
    );
    expect(carl?.via).toEqual([
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
    const permdock = await createPermDock(
      graphPolicy,
      { id: "nobody" },
      { relations: failing },
    );
    const result = await permdock.whoCan(graph.doc.read, rootDoc);
    expect(result).toEqual({
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
    const permdock = await createPermDock(
      graphPolicy,
      { id: "nobody" },
      { relations: source },
    );
    const result = await permdock.whoCan(graph.doc.read, deepDoc);
    expect(ids(result)).toEqual(["eddie", "vera"]);
    expect(result.complete).toBe(false);
  });

  it("stops at a group cycle and at the nested-group depth", async () => {
    const chain = Array.from({ length: 20 }, (_, index) => ({
      team_id: `t${index}`,
      kind: "team",
      subject_id: `t${index + 1}`,
    }));
    const source = memoryRelations(graph, {
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
    const permdock = await createPermDock(
      graphPolicy,
      { id: "nobody" },
      { relations: source },
    );
    const result = await permdock.whoCan(graph.doc.read, rootDoc);
    expect(ids(result)).toEqual(["bea", "near"]);
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
    const permdock = await createPermDock(
      teams,
      { id: "nobody" },
      { relations },
    );
    const review = await permdock.whoCan(
      graph.doc.review,
      rows.doc.find((row) => row.id === "eng-doc"),
    );
    expect(review.holders).toEqual([
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
    const members = await permdock.whoCan(graph.team.read, rows.team[0]);
    expect(ids(members)).toEqual(["carl", "tina"]);
    expect(members.complete).toBe(true);
    const orphan = await permdock.whoCan(graph.doc.review, {
      id: "loose",
      folderId: null,
    });
    expect(orphan.holders).toEqual([]);
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
    const permdock = await createPermDock(
      denied,
      { id: "nobody" },
      { relations },
    );
    const result = await permdock.whoCan(graph.doc.read, deepDoc);
    expect(ids(result)).toEqual(["carl", "tina", "vera"]);
  });

  it("lists nothing for a collection permission or a missing row", async () => {
    const permdock = await createPermDock(graphPolicy, { id: "nobody" });
    const collection = definePermissions({
      doc: resource({ collection: ["create"] }),
    });
    // SAFETY: a collection permission, which whoCan's types refuse, from an untyped caller.
    const create = collection.doc.create as never;
    expect(await permdock.whoCan(create, {})).toEqual({
      permission: "doc.create",
      holders: [],
      complete: false,
    });
    expect(await permdock.whoCan(graph.doc.read, null)).toEqual({
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
    const permdock = await createPermDock(
      scoped,
      { id: "viewer" },
      { memberships: members },
    );
    const read = await permdock.whoCan(tree.task.read, task);
    expect(ids(read)).toEqual(["ann", "olive", "oscar", "rex"]);
    expect(read.complete).toBe(true);
    expect(read.holders[0]?.via).toEqual([
      { kind: "relation", resource: "task", relation: "assignee", id: "t1" },
    ]);
  });

  it("drops a holder a deny grant removes and records no via for the deny", async () => {
    const permdock = await createPermDock(
      scoped,
      { id: "viewer" },
      { memberships: members },
    );
    const update = await permdock.whoCan(tree.task.update, {
      ...task,
      reporterId: "ann",
    });
    expect(update.holders).toEqual([]);
    const close = await permdock.whoCan(tree.task.close, task);
    expect(ids(close)).toEqual(["olive"]);
    expect(close.holders[0]?.via[0]).toMatchObject({
      kind: "role",
      role: "lead",
    });
  });

  it("is incomplete without a member list, and lists nobody for a row outside every scope", async () => {
    const unlisted = await createPermDock(
      scoped,
      { id: "viewer" },
      { memberships: { membershipsFor: () => [] } },
    );
    const read = await unlisted.whoCan(tree.task.read, task);
    expect(ids(read)).toEqual(["ann", "rex"]);
    expect(read.complete).toBe(false);
    const throwing = await createPermDock(
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
    expect((await throwing.whoCan(tree.task.close, task)).complete).toBe(false);
    const permdock = await createPermDock(
      scoped,
      { id: "viewer" },
      { memberships: members },
    );
    const orphan = await permdock.whoCan(tree.task.close, { id: "t2" });
    expect(orphan).toEqual({
      permission: "task.close",
      holders: [],
      complete: true,
    });
    const noField = await permdock.whoCan(tree.task.read, { id: "t3" });
    expect(noField.holders).toEqual([]);
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
      const permdock = await createPermDock(open, { id: "viewer" });
      const result = await permdock.whoCan(tree.task.read, task);
      expect({ to, result }).toEqual({
        to,
        result: { permission: "task.read", holders: [], complete: false },
      });
    }
  });
});
