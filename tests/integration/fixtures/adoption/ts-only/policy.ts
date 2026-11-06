import { allow, definePolicy, role } from "permdock";
import { defineSeeds } from "permdock/seeds";

import { permissions } from "./permissions.ts";

export const policy = definePolicy(permissions, {
  subject: () => null,
  roles: [role("reader", [allow(permissions.note.read)])],
});

export const seeds = defineSeeds(policy, {
  defaults: {
    roles: [
      { key: "reader", scope: "global", grants: [permissions.note.read] },
    ],
  },
  fixtures: { users: { ada: { id: "user-ada" } } },
});
