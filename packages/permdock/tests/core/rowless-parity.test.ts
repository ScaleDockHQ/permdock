import { describe, expect, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";
import type { Membership } from "../../src/core/subject.ts";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { decideLeaf, reasonOf } from "../fixtures/decisions.ts";

const permissions = definePermissions({
  document: resource({
    id: "id",
    actions: ["read", "update"],
    collection: ["create"],
    relations: {
      workspace: { field: "workspaceId", memberOf: "workspace" },
      project: { field: "projectId", memberOf: "project" },
    },
  }),
  note: resource({
    id: "id",
    actions: ["read"],
    relations: {
      workspace: { field: "workspaceId", memberOf: "workspace" },
    },
  }),
});

const policy = definePolicy(permissions, {
  scopes: {
    workspace: { key: "workspaceId" },
    project: { key: "projectId", within: "workspace" },
  },
  subject: (user: { readonly id: string } | null) =>
    user === null ? null : { id: user.id },
  roles: [
    role(
      "editor",
      [
        allow([
          permissions.document.read,
          permissions.document.update,
          permissions.document.create,
          permissions.note.read,
        ]),
      ],
      { on: "workspace" },
    ),
    role(
      "collaborator",
      [allow([permissions.document.read, permissions.document.create])],
      { on: "project" },
    ),
  ],
});

const editorIn = (id: string): Membership => ({
  scope: "workspace",
  id,
  roles: ["editor"],
});
const collaboratorOn = (workspace: string, project: string): Membership => ({
  scope: "project",
  id: project,
  within: { workspace },
  roles: ["collaborator"],
});

const subjects: Readonly<
  Record<
    string,
    { readonly memberships: readonly Membership[]; readonly tenant: string }
  >
> = {
  editor: { memberships: [editorIn("w1")], tenant: "w1" },
  "editor of two workspaces": {
    memberships: [editorIn("w1"), editorIn("w2")],
    tenant: "w2",
  },
  collaborator: { memberships: [collaboratorOn("w1", "p1")], tenant: "w1" },
  "editor and collaborator": {
    memberships: [editorIn("w2"), collaboratorOn("w1", "p1")],
    tenant: "w1",
  },
};

async function both(
  name: string,
): Promise<{ readonly live: PermDock; readonly client: PermDock }> {
  const subject = subjects[name];
  if (subject === undefined) {
    throw new Error(`unknown subject ${name}`);
  }
  const live = await createPermDock(
    policy,
    {
      principal: {
        id: "u1",
        memberships: subject.memberships,
        tenant: subject.tenant,
      },
      context: {},
    },
    { tenant: subject.tenant },
  );
  const snapshot = live.snapshot();
  if (snapshot instanceof Promise) {
    throw new Error("expected JSON snapshot");
  }
  return {
    live,
    client: fromSnapshot(parseSnapshot(JSON.stringify(snapshot)), {
      tenant: subject.tenant,
    }),
  };
}

describe("rowless instance checks: server and snapshot agree", () => {
  const leaves = [
    permissions.document.read,
    permissions.document.update,
    permissions.document.create,
    permissions.note.read,
  ];

  for (const name of Object.keys(subjects)) {
    it(`${name}: same outcome without a row, with team(id) and with rows`, async () => {
      const { live, client } = await both(name);
      const rows = [
        undefined,
        { id: "d1", workspaceId: "w1", projectId: "p1" },
        { id: "d2", workspaceId: "w1", projectId: "p2" },
        { id: "d3", workspaceId: "w2", projectId: "p9" },
      ];
      const pairs = [
        ["active tenant", live, client],
        ["team p1", live.team("p1"), client.team("p1")],
        ["team p2", live.team("p2"), client.team("p2")],
      ] as const;
      for (const leaf of leaves) {
        for (const row of rows) {
          for (const [label, server, snapshot] of pairs) {
            expect(
              decideLeaf(snapshot, leaf, row).outcome,
              `${label} ${leaf.key} ${JSON.stringify(row)}`,
            ).toBe(decideLeaf(server, leaf, row).outcome);
          }
        }
      }
    });
  }

  it("answers a page guard at workspace level on both", async () => {
    const editor = await both("editor");
    expect(editor.live.can(permissions.document.update, undefined)).toBe(true);
    expect(editor.client.can(permissions.document.update, undefined)).toBe(
      true,
    );
    const collaborator = await both("collaborator");
    for (const side of [collaborator.live, collaborator.client]) {
      expect(reasonOf(side.decide(permissions.document.read, undefined))).toBe(
        "scope",
      );
      expect(side.can(permissions.document.create, undefined)).toBe(true);
    }
    expect(
      collaborator.client.team("p1").can(permissions.document.read, undefined),
    ).toBe(true);
  });
});
