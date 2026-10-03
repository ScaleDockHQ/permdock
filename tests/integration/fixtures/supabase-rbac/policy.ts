import { allow, definePolicy, principal, role } from "permdock";

import { permissions } from "./permissions.ts";

const { post } = permissions;

export const policy = definePolicy(permissions, {
  roles: [
    role("staff", [allow(post.read), allow(post.list)]),
    role(
      "admin",
      [
        allow(post.read),
        allow(post.list),
        allow(post.create),
        allow(post.update),
        allow(post.delete),
      ],
      { on: "tenant" },
    ),
    role(
      "member",
      [
        allow(post.read),
        allow(post.list),
        allow(post.create),
        allow(post.update, { where: { authorId: principal.id } }),
      ],
      { on: "tenant" },
    ),
  ],
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
});
