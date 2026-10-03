import { allow, definePolicy, principal, role } from "permdock";

import { permissions } from "./permissions.ts";

export type User = {
  readonly id: string;
  readonly orgId: string;
  readonly roles: readonly string[];
};

const member = role("member", [
  allow(permissions.post.read),
  allow(permissions.post.list),
  allow(permissions.post.create),
  allow(permissions.post.update, { where: { authorId: principal.id } }),
  allow(permissions.post.delete, {
    where: { authorId: principal.id },
    approval: "human",
  }),
]);

export const policy = definePolicy(permissions, {
  roles: [member],
  subject: (user: User | null) =>
    user === null
      ? null
      : { id: user.id, orgId: user.orgId, roles: user.roles },
  validate: "boundary",
});
