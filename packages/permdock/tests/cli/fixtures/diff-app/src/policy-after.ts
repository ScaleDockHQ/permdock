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
      // widened: any member may update
      allow(permissions.post.update),
      // narrowed: deleting now needs an approval
      allow(permissions.post.delete, {
        where: { authorId: principal.id },
        approval: "human",
      }),
      // removed: publish
      allow(permissions.post.archive, {
        validUntil: "2030-01-01T00:00:00Z",
      }),
      // new deny
      deny(permissions.post.read, { where: { published: false } }),
    ]),
    // auditor removed
    role("admin", [allow(permissions.post.read)], { assignable: true }),
  ],
  subject: (user: User | null) => user,
});
