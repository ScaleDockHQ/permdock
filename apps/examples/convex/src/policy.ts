import { allow, definePolicy, role } from "permdock";

import { permissions } from "./permissions.ts";

export const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.post.read),
      allow(permissions.post.list),
    ]),
  ],
  subject: (user: { readonly id: string; readonly roles: readonly string[] }) =>
    user,
  validate: "boundary",
});
