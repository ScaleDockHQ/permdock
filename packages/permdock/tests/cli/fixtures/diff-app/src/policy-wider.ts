import { allow, definePolicy, deny, principal, role } from "permdock";

import { permissions } from "./permissions.ts";

export type User = {
  readonly id: string;
  readonly roles: readonly string[];
};

/** `policy-before` plus a grant, a role and a wider validity: nothing breaking. */
export const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.post.read),
      allow(permissions.post.list),
      allow(permissions.post.update, { where: { authorId: principal.id } }),
      allow(permissions.post.delete, { where: { authorId: principal.id } }),
      allow(permissions.post.publish),
      allow(permissions.post.create),
    ]),
    role("auditor", [allow(permissions.post.read)]),
    role("admin", [
      allow(permissions.post.read),
      deny(permissions.post.archive, { name: "frozen" }),
    ]),
    role("viewer", [allow(permissions.post.read)]),
  ],
  subject: (user: User | null) => user,
});
