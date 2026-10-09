import { allow, definePolicy, deny, role } from "permdock";

import { permissions } from "./permissions.ts";

const { file } = permissions;

export const policy = definePolicy(permissions, {
  roles: [
    role("reader", [allow(file.read)], { on: "tenant" }),
    role("blocked", [deny(file.read)], { on: "tenant" }),
    role("staff", [allow(file.read)]),
    role("suspended", [deny(file.read)]),
  ],
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
});
