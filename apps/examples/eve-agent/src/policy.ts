import { allow, definePolicy, deny, principal, role } from "permdock";

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

const admin = role("admin", [
  ...member.grants,
  allow(permissions.post.update),
  allow(permissions.post.delete),
  allow(permissions.post.publish),
  deny(permissions.post.publish, { where: { published: true } }),
]);

export const policy = definePolicy(permissions, {
  roles: [member, admin],
  subject: (user: User | null) =>
    user === null
      ? null
      : { id: user.id, orgId: user.orgId, roles: user.roles },
  validate: "boundary",
});

export const memberUser: User = { id: "u1", orgId: "o1", roles: ["member"] };
export const adminUser: User = { id: "u2", orgId: "o1", roles: ["admin"] };

const users: readonly User[] = [memberUser, adminUser];

export function userById(id: unknown): User | null {
  return users.find((user) => user.id === id) ?? null;
}
