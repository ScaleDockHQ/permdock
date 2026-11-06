import { allow, definePolicy, role } from "permdock";

import { permissions } from "./permissions.ts";

export const policy = definePolicy(permissions, {
  subject: () => null,
  roles: [role("reader", [allow(permissions.note.read)])],
});
