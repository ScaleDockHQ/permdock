import { allow, deny, principal, relation, role } from "permdock";

import { postPermissions, postRoleVocab } from "./permissions.ts";

export const postRoles = [
  role(postRoleVocab.member, [
    allow(postPermissions.post.read),
    allow(postPermissions.post.list),
    allow(postPermissions.post.create),
    allow(postPermissions.post.update, {
      to: relation(postPermissions.post, "author"),
    }),
    allow(postPermissions.post.delete, {
      where: { authorId: principal.id },
      approval: "human",
    }),
  ]),
  role(postRoleVocab.admin, [
    allow(postPermissions.post.update),
    allow(postPermissions.post.delete),
    allow(postPermissions.post.publish),
    deny(postPermissions.post.publish, { where: { published: true } }),
  ]),
];
