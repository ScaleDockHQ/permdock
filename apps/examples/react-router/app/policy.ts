import { allow, definePolicy, deny, principal, relation, role } from "permdock";

import { permissions, roles } from "./permissions.ts";

export type User = {
  readonly id: string;
  readonly orgId: string;
  readonly roles: readonly string[];
};

const member = role(roles.member, [
  allow(permissions.post.read),
  allow(permissions.post.list),
  allow(permissions.post.create),
  allow(permissions.post.update, {
    to: relation(permissions.post, "author"),
  }),
  allow(permissions.post.delete, {
    where: { authorId: principal.id },
    approval: "human",
  }),
]);

const admin = role(roles.admin, [
  ...member.grants,
  allow(permissions.post.update),
  allow(permissions.post.delete),
  allow(permissions.post.publish),
  deny(permissions.post.publish, { where: { published: true } }),
]);

export const policy = definePolicy(
  { permissions, roles },
  {
    roles: [member, admin],
    principal: (user: User | null) =>
      user === null
        ? null
        : { id: user.id, orgId: user.orgId, roles: user.roles },
    validate: "boundary",
  },
);

export const memberUser: User = { id: "u1", orgId: "o1", roles: ["member"] };
