import { principal } from "../../src/conditions/refs.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";

export const tree = definePermissions({
  org: resource({ actions: ["read"] }),
  post: resource({
    id: "id",
    actions: { read: { title: "Read" }, update: {}, delete: {} },
    collection: ["create"],
    parent: { field: "orgId", resource: "org" },
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      team: { field: "teamId", memberOf: "team" },
    },
  }),
});

export const policy = definePolicy(tree, {
  roles: [
    role("member", [
      allow(tree.post.read),
      allow(tree.post.create),
      allow(tree.post.update, {
        where: { authorId: principal.id },
        check: { authorId: principal.id },
      }),
      allow([tree.post.delete], { where: { authorId: principal.id } }),
    ]),
    role("viewer", [allow(tree.post.read)], { on: "tenant" }),
    role("lead", [allow(tree.post.read)], { on: "team" }),
    role("owner", [allow(tree.post.read)], { on: tree.org.read }),
  ],
  scopes: {
    tenant: { key: "orgId" },
    team: { key: "teamId", within: "tenant" },
  },
  subject: (user: { readonly id: string } | null) =>
    user === null ? null : { id: user.id, roles: ["member"] },
  context: (user) => (user === null ? {} : { teamIds: ["t1"] }),
  validate: "boundary",
  onDenied: () => undefined,
});

export const memberPrincipal = { id: "u1", roles: ["member"] };
