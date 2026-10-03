import { allow, definePolicy, deny, principal, role } from "permdock";

import { permissions } from "./permissions.ts";

export type User = {
  readonly id: string;
  readonly roles: readonly string[];
};

export const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.post.read),
      allow(permissions.post.list),
      allow(permissions.post.update, { where: { authorId: principal.id } }),
      allow(permissions.post.delete, { where: { authorId: principal.id } }),
      allow(permissions.post.publish),
    ]),
    role("auditor", [allow(permissions.post.read)]),
    role("admin", [
      allow(permissions.post.read),
      deny(permissions.post.archive, { name: "frozen" }),
    ]),
  ],
  subject: (user: User | null) => user,
});
